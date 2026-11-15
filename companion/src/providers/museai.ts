import { accountLabel, feedWindow, valueWindow, isRecord, type FeedAccount } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

class SignIn extends Error {}
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export const museai: Provider = {
  id: "museai",
  name: "Muse",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: "museai",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const invalid = (): never => {
      throw new HttpError("Muse", 200);
    };
    const object = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : invalid());
    const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : invalid());
    const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const response = await context.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited("Muse", now + retryAfterSeconds(response.headers, 300));
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "";
        if (/auth\.muse\.ai|(?:^|[/?#])(?:login|sign-?in|auth|oauth|sso)(?:[/?#]|$)/i.test(location))
          throw new SignIn();
      }
      if (!response.ok) throw new HttpError("Muse", response.status);
      return response;
    };
    try {
      if ((await providerEntry(context, "museai")).cookieSource === "off") throw new NotConfigured("Muse");
      const cookie = await cookieHeader(context, "museai", { domains: ["muse.ai"] });
      if (!cookie) throw new NotConfigured("Muse");
      const origin = "https://muse.ai";
      const paths = (text: string) => [
        ...new Set((text.match(/static\/chunks\/[\w~.-]+\.js/g) ?? []).map((p) => `/_next/${p}`)),
      ];
      const get = async (url: string, headers: Record<string, string>) => {
        const response = await request(url, { headers });
        return response.text();
      };
      const chunk = async (path: string) => {
        try {
          return await get(`${origin}${path}`, { Accept: "*/*", "User-Agent": UA });
        } catch (error) {
          if (error instanceof HttpError) return "";
          throw error;
        }
      };
      const page = await get(`${origin}/`, { Cookie: cookie, Accept: "text/html", "User-Agent": UA });
      let text = "",
        action: string | undefined;
      const chunks = paths(page).slice(0, 96);
      for (let i = 0; i < chunks.length && !action; i += 8) {
        const batch = await Promise.all(chunks.slice(i, i + 8).map(chunk));
        text += "\n" + batch.join("\n");
        if (text.length > 8 * 1024 * 1024) invalid();
        const module = /\.A\((\d+)\)\.then\(\(\{[^}]*Settings/.exec(text)?.[1];
        const loader =
          module && new RegExp(`[,{\\[]${module},\\w+=>\\{\\w+\\.v\\(\\w+=>Promise\\.all\\(\\[([^\\]]*)`).exec(text);
        if (!loader) continue;
        const settings = paths(loader[1]).slice(0, 32);
        for (let j = 0; j < settings.length && !action; j += 8) {
          for (const body of await Promise.all(settings.slice(j, j + 8).map(chunk))) {
            action = /"([0-9a-f]{40,})",[^"]{0,200}"fetchSubscriptionAction"/.exec(body)?.[1];
            if (action) break;
          }
        }
        break;
      }
      if (!action) return invalid();
      // Discover per refresh rather than persisting deploy-specific server action identifiers.
      const response = await request(`${origin}/`, {
        method: "POST",
        body: JSON.stringify([{ includeAgreement: true }]),
        headers: {
          Cookie: cookie,
          Accept: "text/x-component",
          "Next-Action": action,
          Origin: origin,
          "Content-Type": "text/plain;charset=UTF-8",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
          "User-Agent": UA,
        },
      });
      let sub: Record<string, unknown> | null = null;
      for (const line of (await response.text()).split("\n")) {
        const match = /^[0-9a-f]+:(\{.*\})\s*$/.exec(line);
        if (!match) continue;
        let row: unknown;
        try {
          row = JSON.parse(match[1]);
        } catch {
          continue;
        }
        if (isRecord(row) && row.success === true && isRecord(row.subscription)) sub = row.subscription;
      }
      if (!sub) return invalid();
      const usage = object(sub.usage);
      const reset = usage.resetsAt == null ? null : number(usage.resetsAt);
      base.windows = [feedWindow(10080, Math.min(100, Math.max(0, number(usage.percentUsed))), reset, now)];
      if (typeof sub.topupTotal === "number" && sub.topupTotal > 0) {
        base.windows.push(valueWindow("topup", `$${(number(sub.topupBalance) / 1e6).toFixed(2)}`));
      }
      for (const lane of base.windows) {
        if (lane.value && lane.value.length > 12) {
          const match = /^(\$?)([-+0-9.,e]+)(.*)$/.exec(lane.value);
          if (match) lane.value = `${match[1]}${Number(match[2].replace(/,/g, "")).toExponential(2)}${match[3]}`;
        }
      }
      if (base.windows.some((lane) => lane.used_percent !== null && !Number.isFinite(lane.used_percent))) invalid();
      base.blocked ||= base.windows.some((w) => (w.used_percent ?? 0) >= 100);
      return [base];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, windows: [], error: "sign in" }];
      throw error;
    }
  },
};
