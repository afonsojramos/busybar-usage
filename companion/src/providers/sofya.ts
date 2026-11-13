import { accountLabel, valueWindow, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const sofya: Provider = {
  id: "sofya",
  name: "Sofya",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "sofya", ["SOFYA_API_KEY"]);
    if (!key) throw new NotConfigured("Sofya");
    const now = context.now();
    const base: FeedAccount = {
      provider: "sofya", provider_name: "Sofya", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers = { Authorization: `Bearer ${key}` };
    const response = await context.fetch("https://sofya.co/v1/auth/me", {
      headers, signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Sofya", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Sofya", response.status);
    const fail = (): never => { throw new HttpError("Sofya", response.status); };
    const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : fail();
    const number = (value: unknown, signed = false): number =>
      typeof value === "number" && Number.isFinite(value) && (signed || value >= 0) ? value : fail();
    const compact = (value: number): string => {
      const text = new Intl.NumberFormat("en-US", {
        notation: "compact", maximumFractionDigits: 2,
      }).format(value);
      return text.length <= 8 ? text : value.toExponential(0);
    };
    let data: Record<string, unknown>;
    try { data = record(await response.json()); } catch { return fail(); }
    const windows: FeedWindow[] = [];
    if (data.is_free_tier != null && typeof data.is_free_tier !== "boolean") fail();
    let reset: number | null = null;
    if (data.credits_reset_at != null) {
      const raw = data.credits_reset_at;
      if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)) fail();
      const text = String(raw);
      const [year, month, day] = text.slice(0, 10).split("-").map(Number);
      reset = isoToSeconds(text);
      if (reset === null || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) fail();
    }
    const balances = ["credits", "plan_credits", "purchased_credits"].map(key =>
      data[key] == null ? null : number(data[key]));
    if (balances.every(value => value === null)) fail();
    const [available, plan, purchased] = balances;
    if (plan != null) windows.push(valueWindow("plan", `${compact(plan)} cr`, data.is_free_tier === true ? reset : null));
    if (purchased != null) windows.push(valueWindow("bought", `${compact(purchased)} cr`));
    if (windows.length < 2 && available != null) windows.unshift(valueWindow("credits", `${compact(available)} cr`));
    base.blocked = available === 0;
    return [{
      ...base, account: accountLabel(typeof data.email === "string" ? data.email : null),
      windows, blocked: base.blocked || windows.some(window => (window.used_percent ?? 0) >= 100)
    }];
  },
};
