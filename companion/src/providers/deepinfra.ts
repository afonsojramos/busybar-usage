import { accountLabel, feedWindow, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { apiKey } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  type Provider,
  type RequestOptions,
} from "./types.ts";

function amount(value: number, prefix = "$"): string {
  const fixed = `${prefix}${value.toFixed(2)}`;
  return fixed.length <= 12 ? fixed : `${prefix}${value.toExponential(2)}`;
}

const SIGN_IN = Symbol("sign in");

export const deepinfra: Provider = {
  id: "deepinfra",
  name: "DeepInfra",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "deepinfra", ["DEEPINFRA_API_KEY", "DEEPINFRA_TOKEN"]);
    if (!key) throw new NotConfigured("DeepInfra");
    const now = context.now();
    const base: FeedAccount = {
      provider: "deepinfra",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    async function request(url: string, init: RequestOptions = {}): Promise<unknown> {
      const response = await context.fetch(url, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) return SIGN_IN;
      if (response.status === 429) throw new RateLimited("DeepInfra", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("DeepInfra", response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError("DeepInfra", response.status);
      }
    }
    const checklist = await request("https://api.deepinfra.com/payment/checklist?compute_owed=true");
    if (checklist === SIGN_IN) return [{ ...base, error: "sign in" }];
    const usage = await request("https://api.deepinfra.com/payment/usage?from=current");
    if (usage === SIGN_IN) return [{ ...base, error: "sign in" }];
    if (!isRecord(checklist) || !isRecord(usage) || !Array.isArray(usage.months)) throw new HttpError("DeepInfra", 200);
    const number = (value: unknown): number => {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError("DeepInfra", 200);
      return value;
    };
    const recent = Math.max(0, number(checklist.recent));
    const balance = number(checklist.stripe_balance) + recent;
    if (!Number.isFinite(balance) || (checklist.suspended != null && typeof checklist.suspended !== "boolean")) {
      throw new HttpError("DeepInfra", 200);
    }
    if (
      (checklist.suspend_reason != null && typeof checklist.suspend_reason !== "string") ||
      (usage.initial_month != null && typeof usage.initial_month !== "string")
    )
      throw new HttpError("DeepInfra", 200);
    const limit = checklist.limit == null ? null : number(checklist.limit);
    const costs = usage.months.map((month: unknown) => {
      if (!isRecord(month) || typeof month.period !== "string") throw new HttpError("DeepInfra", 200);
      return number(month.total_cost);
    });
    // Checklist amounts are dollars; monthly usage costs are cents.
    const spent = Math.max(0, costs.length ? (costs.at(-1) ?? 0) / 100 : recent);
    const windows =
      limit !== null && limit > 0 ? [feedWindow(null, Math.min(100, (recent / limit) * 100), null, now, "cycle")] : [];
    windows.push(valueWindow(balance > 0 ? "owed" : "bal", amount(Math.abs(balance))));
    if (!windows.some((w) => w.used_percent !== null)) windows.push(valueWindow("spent", amount(spent)));
    return [
      {
        ...base,
        blocked: checklist.suspended === true || balance >= 0 || windows.some((w) => (w.used_percent ?? 0) >= 100),
        windows,
      },
    ];
  },
};
