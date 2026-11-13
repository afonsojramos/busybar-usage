import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
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

export const venice: Provider = {
  id: "venice",
  name: "Venice",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "venice", ["VENICE_API_KEY", "VENICE_KEY"]);
    if (!key) throw new NotConfigured("Venice");
    const now = context.now();
    const base: FeedAccount = {
      provider: "venice",
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
      if (response.status === 429) throw new RateLimited("Venice", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Venice", response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError("Venice", response.status);
      }
    }
    const data = await request("https://api.venice.ai/api/v1/billing/balance");
    if (data === SIGN_IN) return [{ ...base, error: "sign in" }];
    if (
      !isRecord(data) ||
      typeof data.canConsume !== "boolean" ||
      !isRecord(data.balances) ||
      (data.consumptionCurrency != null && typeof data.consumptionCurrency !== "string")
    ) {
      throw new HttpError("Venice", 200);
    }
    const optional = (value: unknown): number | null => {
      if (value == null || value === "") return null;
      const number = finiteNumber(value);
      if (number === null) throw new HttpError("Venice", 200);
      return number;
    };
    const diem = optional(data.balances.diem);
    const usd = optional(data.balances.usd);
    const allocation = optional(data.diemEpochAllocation);
    const currency = typeof data.consumptionCurrency === "string" ? data.consumptionCurrency.toUpperCase() : null;
    const windows: FeedWindow[] = [];
    if (currency !== "USD" && diem !== null && allocation !== null && allocation > 0) {
      windows.push(
        feedWindow(null, Math.min(100, Math.max(0, ((allocation - diem) / allocation) * 100)), null, now, "DIEM"),
      );
    } else if (diem !== null) windows.push(valueWindow("DIEM", amount(diem, "")));
    if (usd !== null) windows.push(valueWindow("USD", amount(usd)));
    if (currency === "USD") windows.sort((a, b) => Number(b.name === "USD") - Number(a.name === "USD"));
    return [
      {
        ...base,
        blocked:
          !data.canConsume ||
          ((diem ?? 0) <= 0 && (usd ?? 0) <= 0) ||
          windows.some((w) => (w.used_percent ?? 0) >= 100),
        windows,
      },
    ];
  },
};
