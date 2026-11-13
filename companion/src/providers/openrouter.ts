import { accountLabel, feedWindow, finiteNumber, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider, isProviderHost, type RequestOptions } from "./types.ts";

function amount(value: number, prefix = "$"): string {
  const fixed = `${prefix}${value.toFixed(2)}`;
  return fixed.length <= 12 ? fixed : `${prefix}${value.toExponential(2)}`;
}

function apiBase(raw: string | undefined, fallback: string): string {
  try {
    const text = raw?.trim() || fallback;
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (!isProviderHost(url, ["openrouter.ai"]) || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new HttpError("OpenRouter", 0);
  }
}

const SIGN_IN = Symbol("sign in");

export const openrouter: Provider = {
  id: "openrouter",
  name: "OpenRouter",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "openrouter", ["OPENROUTER_API_KEY"]);
    if (!key) throw new NotConfigured("OpenRouter");
    const now = context.now();
    const base: FeedAccount = {
      provider: "openrouter", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    async function request(url: string, init: RequestOptions = {}): Promise<unknown> {
      const response = await context.fetch(url, {
        ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) return SIGN_IN;
      if (response.status === 429) throw new RateLimited("OpenRouter", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("OpenRouter", response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError("OpenRouter", response.status);
      }
    }
    const url = apiBase(context.env.OPENROUTER_API_URL, "https://openrouter.ai/api/v1");
    headers["X-Title"] = context.env.OPENROUTER_X_TITLE?.trim() || "CodexBar";
    if (context.env.OPENROUTER_HTTP_REFERER?.trim()) headers["HTTP-Referer"] = context.env.OPENROUTER_HTTP_REFERER.trim();
    const credits = await request(`${url}/credits`);
    if (credits === SIGN_IN) return [{ ...base, error: "sign in" }];
    if (!isRecord(credits) || !isRecord(credits.data)) throw new HttpError("OpenRouter", 200);
    const number = (value: unknown): number => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError("OpenRouter", 200);
      return value;
    };
    const balance = Math.max(0, number(credits.data.total_credits) - number(credits.data.total_usage));
    if (!Number.isFinite(balance)) throw new HttpError("OpenRouter", 200);
    const keyData = await request(`${url}/key`);
    if (keyData === SIGN_IN) return [{ ...base, error: "sign in" }];
    if (!isRecord(keyData) || !isRecord(keyData.data)) throw new HttpError("OpenRouter", 200);
    const data = keyData.data;
    for (const key of ["limit", "limit_remaining", "usage", "usage_daily", "usage_weekly", "usage_monthly"]) {
      if (data[key] != null) number(data[key]);
    }
    if (data.limit_reset != null && typeof data.limit_reset !== "string") throw new HttpError("OpenRouter", 200);
    const limit = finiteNumber(data.limit);
    const remaining = finiteNumber(data.limit_remaining);
    const reset = data.limit_reset;
    const minutes = reset === "daily" ? 1440 : reset === "weekly" ? 10080 : reset === "monthly" ? 43200 : null;
    const windowUsage = reset === "daily" ? data.usage_daily : reset === "weekly" ? data.usage_weekly
      : reset === "monthly" ? data.usage_monthly : null;
    const used = limit !== null && remaining !== null ? limit - Math.min(limit, Math.max(0, remaining))
      : finiteNumber(windowUsage) ?? finiteNumber(data.usage);
    const windows: FeedWindow[] = [];
    if (limit !== null && limit > 0 && used !== null && used >= 0) {
      windows.push(feedWindow(minutes, Math.min(100, used / limit * 100), null, now, minutes === null ? "cap" : undefined));
    }
    windows.push(valueWindow("bal", amount(balance)));
    return [{ ...base, blocked: balance <= 0 || windows.some((w) => (w.used_percent ?? 0) >= 100), windows }];
  },
};
