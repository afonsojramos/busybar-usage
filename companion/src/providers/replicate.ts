import { accountLabel, valueWindow, isoToSeconds, isRecord, type FeedAccount } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

class SignIn extends Error { }

export const replicate: Provider = {
  id: "replicate",
  name: "Replicate",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: "replicate", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: []
    };
    const invalid = (): never => { throw new HttpError("Replicate", 200); };
    const object = (v: unknown): Record<string, unknown> => isRecord(v) ? v : invalid();
    const decode = (text: string): unknown => { try { return JSON.parse(text); } catch { return invalid(); } };
    const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const response = await context.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited("Replicate", now + retryAfterSeconds(response.headers, 300));
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "";
        if (/auth\.muse\.ai|(?:^|[/?#])(?:login|sign-?in|auth|oauth|sso)(?:[/?#]|$)/i.test(location)) throw new SignIn();
      }
      if (!response.ok) throw new HttpError("Replicate", response.status);
      return response;
    };
    try {
      if ((await providerEntry(context, "replicate")).cookieSource === "off") throw new NotConfigured("Replicate");
      const cookie = await cookieHeader(context, "replicate", { domains: ["replicate.com"], required: ["sessionid"] });
      if (!cookie) throw new NotConfigured("Replicate");
      const headers = { Cookie: cookie };
      const page = await request("https://replicate.com/account/billing", { headers: { ...headers, Accept: "text/html" } });
      const html = await page.text();
      let account: { kind: string; username: string } | null = null;
      const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
      let match: RegExpExecArray | null;
      let visited = 0;
      while ((match = scripts.exec(html)) && !account && visited < 4000) {
        if (!/\bid\s*=\s*(["'])react-component-props[^"']*\1/i.test(match[1]) ||
          !/\btype\s*=\s*(["'])application\/json\1/i.test(match[1])) continue;
        let payload: unknown;
        try { payload = JSON.parse(match[2]); } catch { continue; }
        const queue: unknown[] = [payload];
        for (let i = 0;i < queue.length && visited++ < 4000;i++) {
          const item = queue[i], obj = isRecord(item) ? item : null;
          const candidate = obj?.account;
          if (isRecord(candidate) && (candidate.kind === "user" || candidate.kind === "organization") &&
            typeof candidate.username === "string" && candidate.username.trim()) {
            account = { kind: candidate.kind, username: candidate.username.trim() }; break;
          }
          for (const child of Array.isArray(item) ? item : obj ? Object.values(obj) : []) {
            if (queue.length >= 4000) break;
            if (child !== null && typeof child === "object") queue.push(child);
          }
        }
      }
      if (!account) {
        if (/<title>\s*Sign in\s*\|\s*Replicate\s*<\/title>/i.test(html) && /href=["']\/login\/github\//i.test(html)) throw new SignIn();
        return invalid();
      }
      const url = `https://replicate.com/api/${account.kind === "organization" ? "organizations" : "users"}/${encodeURIComponent(account.username)}`;
      const invoices = object(decode(await (await request(`${url}/invoices`, { headers })).text())).invoices;
      if (!Array.isArray(invoices)) return invalid();
      const current = invoices.find(v => isRecord(v) && v.type === "monthly-usage" &&
        (v.ended_before == null || (isoToSeconds(v.ended_before) ?? 0) > now));
      if (!isRecord(current)) return invalid();
      const money = (v: unknown): number => typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v.trim()) &&
        Number.isFinite(Number(v)) ? Number(v) : invalid();
      base.windows = [valueWindow("spent", `$${money(current.total_cost_before_adjustments).toFixed(2)}`)];
      // Credit is optional in CodexBar; a failed credit read must preserve the invoice spend.
      try {
        const credit = object(decode(await (await request(`${url}/unused-credit`, { headers })).text()));
        base.windows.push(valueWindow("balance", `$${money(credit.unused_credit).toFixed(2)}`));
      } catch (error) {
        if (error instanceof SignIn || error instanceof RateLimited) throw error;
      }
      for (const lane of base.windows) {
        if (lane.value && lane.value.length > 12) {
          const match = /^(\$?)([-+0-9.,e]+)(.*)$/.exec(lane.value);
          if (match) lane.value = `${match[1]}${Number(match[2].replace(/,/g, "")).toExponential(2)}${match[3]}`;
        }
      }
      if (base.windows.some(lane => lane.used_percent !== null && !Number.isFinite(lane.used_percent))) invalid();
      base.blocked ||= base.windows.some(w => (w.used_percent ?? 0) >= 100);
      return [base];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, windows: [], error: "sign in" }];
      throw error;
    }
  },
};
