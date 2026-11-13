import {
  accountLabel,
  feedWindow,
  valueWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  type FeedAccount,
} from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

class SignIn extends Error {}
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export const raycast: Provider = {
  id: "raycast",
  name: "Raycast",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: "raycast",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const invalid = (): never => {
      throw new HttpError("Raycast", 200);
    };
    const object = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : invalid());
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
      if (response.status === 429) throw new RateLimited("Raycast", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Raycast", response.status);
      return response;
    };
    try {
      if ((await providerEntry(context, "raycast")).cookieSource === "off") throw new NotConfigured("Raycast");
      const raw = await cookieHeader(context, "raycast", {
        domains: ["raycast.com", "www.raycast.com"],
        required: ["__raycast_session"],
      });
      const cookie = raw
        ?.split(";")
        .map((p) => p.trim())
        .filter((p) => /^(?:__raycast_session|csrf_token)=/.test(p))
        .join("; ");
      if (!cookie || !/(?:^|;\s*)__raycast_session=[^;]+/.test(cookie)) throw new NotConfigured("Raycast");
      const response = await request("https://www.raycast.com/frontend_api/current_user/ai_credits", {
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          Origin: "https://www.raycast.com",
          Referer: "https://www.raycast.com/settings",
          "User-Agent": UA,
        },
      });
      const root = object(decode(await response.text()));
      const amount = (v: unknown): number | null => {
        if (v == null) return null;
        const n = finiteNumber(v);
        return n !== null && n >= 0 ? n : invalid();
      };
      const left = amount(root.remaining_balance_credits),
        total = amount(root.total_balance_credits);
      if (left === null && total === null) invalid();
      const reset = isoToSeconds(root.next_credits_at);
      if (root.next_credits_at != null && reset === null) invalid();
      if (left !== null && total !== null && total > 0) {
        base.windows = [feedWindow(null, (Math.max(0, total - left) / total) * 100, reset, now, "credits")];
      } else {
        if (left !== null) base.windows.push(valueWindow("left", `${left} cr`, reset));
        if (total !== null) base.windows.push(valueWindow("total", `${total} cr`, reset));
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
