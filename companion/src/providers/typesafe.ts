import { accountLabel, valueWindow, isRecord, type FeedAccount } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

class SignIn extends Error {}
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export const typesafe: Provider = {
  id: "typesafe",
  name: "TypeSafe",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: "typesafe",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const invalid = (): never => {
      throw new HttpError("TypeSafe", 200);
    };
    const object = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : invalid());
    const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : invalid());
    const decode = (text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return invalid();
      }
    };
    const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const response = await context.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited("TypeSafe", now + retryAfterSeconds(response.headers, 300));
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "";
        let target: URL;
        try {
          target = new URL(location, url);
        } catch {
          throw new HttpError("TypeSafe", response.status);
        }
        const ownHost = target.hostname === "typesafe.ai" || target.hostname.endsWith(".typesafe.ai");
        if (!ownHost || /(?:^|[/?#])(?:login|sign-?in|auth|oauth|sso)(?:[/?#]|$)/i.test(location)) throw new SignIn();
      }
      if (!response.ok) throw new HttpError("TypeSafe", response.status);
      return response;
    };
    try {
      if ((await providerEntry(context, "typesafe")).cookieSource === "off") throw new NotConfigured("TypeSafe");
      const cookie = await cookieHeader(context, "typesafe", { domains: ["console.typesafe.ai", "typesafe.ai"] });
      if (!cookie) throw new NotConfigured("TypeSafe");
      const response = await request("https://console.typesafe.ai/api/billing/overview", {
        headers: { Cookie: cookie, Accept: "application/json", "User-Agent": UA },
      });
      const text = (await response.text()).trim();
      if (text.startsWith("<") && /login|sign[-\s]?in|\(auth\)/i.test(text)) throw new SignIn();
      const billing = object(object(decode(text)).billing);
      base.windows = [
        valueWindow("balance", `$${number(billing.balance).toFixed(2)}`),
        valueWindow("spent", `$${number(billing.spent).toFixed(2)}`),
      ];
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
