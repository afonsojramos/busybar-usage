import { accountLabel, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const sailresearch: Provider = {
  id: "sailresearch",
  name: "Sail Research",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "sailresearch", ["SAIL_API_KEY"]);
    if (!key) throw new NotConfigured("Sail Research");
    const now = context.now();
    const base: FeedAccount = {
      provider: "sailresearch", provider_name: "Sail Research", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers = { Authorization: `Bearer ${key}` };
    const response = await context.fetch("https://api.sailresearch.com/v2/usage/summary?range=30d", {
      headers, signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Sail Research", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Sail Research", response.status);
    const fail = (): never => { throw new HttpError("Sail Research", response.status); };
    const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : fail();
    const number = (value: unknown, signed = false): number =>
      typeof value === "number" && Number.isFinite(value) && (signed || value >= 0) ? value : fail();
    const compact = (value: number): string => {
      const text = new Intl.NumberFormat("en-US", {
        notation: "compact", maximumFractionDigits: 2,
      }).format(value);
      return text.length <= 8 ? text : value.toExponential(0);
    };
    const dollars = (value: number): string => {
      const text = `$${value.toFixed(2)}`;
      return text.length <= 12 ? text : `$${compact(value)}`;
    };
    let data: Record<string, unknown>;
    try { data = record(await response.json()); } catch { return fail(); }
    const windows: FeedWindow[] = [];
    if (data.object !== "usage.summary" || data.available !== true || data.has_metronome_customer !== true
      || typeof data.balance_unavailable !== "boolean") fail();
    if (typeof data.effective_range !== "string" || !["1h", "6h", "24h", "7d", "30d", "period"].includes(data.effective_range)) fail();
    const spend = number(data.period_spend) / 100;
    if (!data.balance_unavailable) windows.push(valueWindow("balance", dollars(number(data.balance, true) / 100)));
    windows.push(valueWindow(String(data.effective_range), dollars(spend)));
    return [{
      ...base, account: accountLabel(typeof data.email === "string" ? data.email : null),
      windows, blocked: base.blocked || windows.some(window => (window.used_percent ?? 0) >= 100)
    }];
  },
};
