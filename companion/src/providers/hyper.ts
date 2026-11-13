import { accountLabel, valueWindow, isRecord, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

class SignIn extends Error { }

export const hyper: Provider = {
  id: "hyper",
  name: "Hyper",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: "hyper", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: []
    };
    const invalid = (): never => { throw new HttpError("Hyper", 200); };
    const object = (v: unknown): Record<string, unknown> => isRecord(v) ? v : invalid();
    const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : invalid();
    const decode = (text: string): unknown => { try { return JSON.parse(text); } catch { return invalid(); } };
    const request = async (url: string, init: RequestInit = {}, redirects = 0): Promise<Response> => {
      const response = await context.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited("Hyper", now + retryAfterSeconds(response.headers, 300));
      if (response.status >= 300 && response.status < 400) {
        const target = new URL(response.headers.get("location") ?? "/", url);
        if (redirects < 5 && target.origin === "https://hyper.charm.land" && /^\/teams\/[0-9a-f-]{36}\//.test(target.pathname)) {
          return request(target.href, init, redirects + 1);
        }
        throw new SignIn();
      }
      if (!response.ok) throw new HttpError("Hyper", response.status);
      return response;
    };
    try {
      const key = await apiKey(context, "hyper", ["HYPER_API_KEY"]);
      const entry = await providerEntry(context, "hyper");
      const cookie = entry.cookieSource === "off" ? null : await cookieHeader(context, "hyper", { domains: ["hyper.charm.land"] });
      let response: Response | null = null;
      let session = false;
      const selected = isRecord(entry.tokenAccounts) && Array.isArray(entry.tokenAccounts.accounts) && entry.tokenAccounts.accounts.length > 0;
      if (cookie && !selected) {
        try {
          response = await request("https://hyper.charm.land/", { headers: { Cookie: cookie, Accept: "text/html" } });
          session = true;
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          if (!key || error instanceof RateLimited || error instanceof HttpError && error.status >= 400) throw error;
        }
      }
      if (!response) {
        if (!key) throw new NotConfigured("Hyper");
        response = await request("https://hyper.charm.land/v1/credits", { headers: { Authorization: `Bearer ${key}` } });
      }
      let balance: number;
      if (session) {
        const html = await response.text();
        if (!/\/teams\/[0-9a-f-]{36}/.test(response.url) && !/\/teams\/[0-9a-f-]{36}/.test(html)) {
          if (!key) throw new SignIn();
          const api = await request("https://hyper.charm.land/v1/credits", { headers: { Authorization: `Bearer ${key}` } });
          balance = number(object(decode(await api.text())).balance);
        } else {
          const match = /Hypercredits Available[\s\S]{0,400}?text-5xl font-bold">\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*</.exec(html);
          balance = match ? Number(match[1].replace(/,/g, "")) : invalid();
        }
      } else balance = number(object(decode(await response.text())).balance);
      if (!Number.isFinite(balance) || balance < 0) invalid();
      base.windows = [valueWindow("balance", `${balance.toLocaleString("en-US", { maximumFractionDigits: 2 })} HC`)];
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
