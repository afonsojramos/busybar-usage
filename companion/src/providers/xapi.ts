import { accountLabel, valueWindow, isRecord, type FeedAccount } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

class SignIn extends Error { }

export const xapi: Provider = {
  id: "xapi",
  name: "X API",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: "xapi", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: []
    };
    const invalid = (): never => { throw new HttpError("X API", 200); };
    const object = (v: unknown): Record<string, unknown> => isRecord(v) ? v : invalid();
    const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : invalid();
    const decode = (text: string): unknown => { try { return JSON.parse(text); } catch { return invalid(); } };
    const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const response = await context.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited("X API", now + retryAfterSeconds(response.headers, 300));
      if (response.status === 400) {
        let body: unknown;
        try { body = await response.clone().json(); } catch { body = null; }
        if (isRecord(body) && Array.isArray(body.errors) && body.errors.some(e => isRecord(e) && e.code === 215)) throw new SignIn();
      }
      if (!response.ok) throw new HttpError("X API", response.status);
      return response;
    };
    try {
      if ((await providerEntry(context, "xapi")).cookieSource === "off") throw new NotConfigured("X API");
      const cookie = await cookieHeader(context, "xapi", { domains: ["x.com", "console.x.com"], required: ["auth_token", "ct0"] });
      if (!cookie) throw new NotConfigured("X API");
      const csrf = /(?:^|;\s*)ct0=([^;]+)/.exec(cookie)?.[1];
      if (!csrf || !/(?:^|;\s*)auth_token=[^;]+/.test(cookie)) throw new NotConfigured("X API");
      const headers = { Cookie: cookie, "X-CSRF-Token": csrf, Accept: "application/json" };
      const get = async (path: string) => object(decode(await (await request(`https://console.x.com${path}`, { headers })).text()));
      const me = await get("/api/me");
      const id = object(me.account).id;
      const account = Number.isSafeInteger(id) && Number(id) >= 0 ? String(id) : id;
      if (typeof account !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(account)) return invalid();
      const credits = await get(`/api/accounts/${account}/credits`);
      const paid = number(object(credits.credits).balance);
      const free = credits.freeCredits === undefined ? 0 : number(object(credits.freeCredits).balance);
      base.windows = [valueWindow("balance", `$${number(paid + free).toFixed(2)}`)];
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
