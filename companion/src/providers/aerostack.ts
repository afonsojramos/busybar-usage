import { accountLabel, feedWindow, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const aerostack: Provider = {
  id: "aerostack",
  name: "Aerostack",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "aerostack", ["AEROSTACK_TOKEN"]);
    if (!key) throw new NotConfigured("Aerostack");
    const now = context.now();
    const base: FeedAccount = {
      provider: "aerostack",
      provider_name: "Aerostack",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const headers = { Authorization: `Bearer ${key}` };
    const response = await context.fetch("https://api.aerostack.dev/api/billing/usage", {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Aerostack", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Aerostack", response.status);
    const fail = (): never => {
      throw new HttpError("Aerostack", response.status);
    };
    const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : fail());
    const number = (value: unknown, signed = false): number =>
      typeof value === "number" && Number.isFinite(value) && (signed || value >= 0) ? value : fail();
    const integer = (value: unknown): number => {
      const n = number(value);
      return Number.isSafeInteger(n) ? n : fail();
    };
    const compact = (value: number): string => {
      const text = new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);
      return text.length <= 8 ? text : value.toExponential(0);
    };
    let data: Record<string, unknown>;
    try {
      data = record(await response.json());
    } catch {
      return fail();
    }
    const windows: FeedWindow[] = [];
    const tokens = record(record(data.usage).ai_tokens);
    const count = (value: unknown) => (value == null ? null : integer(value));
    const used = count(tokens.used);
    const limit = count(tokens.limit);
    if (used === null && limit === null) fail();
    if (data.period != null && (typeof data.period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(data.period)))
      fail();
    if (data.tier != null && (typeof data.tier !== "string" || data.tier.length > 120)) fail();
    if (used !== null && limit !== null && limit > 0)
      windows.push(feedWindow(43200, Math.min(100, (used / limit) * 100), null, now));
    else if (used !== null) windows.push(valueWindow("used", compact(used)));
    else if (limit !== null) windows.push(valueWindow("limit", compact(limit)));
    return [
      {
        ...base,
        account: accountLabel(typeof data.email === "string" ? data.email : null),
        windows,
        blocked: base.blocked || windows.some((window) => (window.used_percent ?? 0) >= 100),
      },
    ];
  },
};
