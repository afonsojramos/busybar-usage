import { accountLabel, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const linkup: Provider = {
  id: "linkup",
  name: "Linkup",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "linkup", ["LINKUP_API_KEY"]);
    if (!key) throw new NotConfigured("Linkup");
    const now = context.now();
    const base: FeedAccount = {
      provider: "linkup", provider_name: "Linkup", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers = { Authorization: `Bearer ${key}` };
    const response = await context.fetch("https://api.linkup.so/v1/credits/balance", {
      headers, signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Linkup", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Linkup", response.status);
    const fail = (): never => { throw new HttpError("Linkup", response.status); };
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
    windows.push(valueWindow("balance", dollars(number(data.balance, true))));
    return [{
      ...base, account: accountLabel(typeof data.email === "string" ? data.email : null),
      windows, blocked: base.blocked || windows.some(window => (window.used_percent ?? 0) >= 100)
    }];
  },
};
