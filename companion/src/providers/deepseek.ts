import { accountLabel, finiteNumber, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
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

export const deepseek: Provider = {
  id: "deepseek",
  name: "DeepSeek",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "deepseek", ["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"]);
    if (!key) throw new NotConfigured("DeepSeek");
    const now = context.now();
    const base: FeedAccount = {
      provider: "deepseek",
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
      if (response.status === 429) throw new RateLimited("DeepSeek", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("DeepSeek", response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError("DeepSeek", response.status);
      }
    }
    const data = await request("https://api.deepseek.com/user/balance");
    if (data === SIGN_IN) return [{ ...base, error: "sign in" }];
    if (!isRecord(data) || typeof data.is_available !== "boolean" || !Array.isArray(data.balance_infos)) {
      throw new HttpError("DeepSeek", 200);
    }
    const balances = data.balance_infos.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry.currency !== "string") throw new HttpError("DeepSeek", 200);
      const numbers = [entry.total_balance, entry.granted_balance, entry.topped_up_balance];
      if (numbers.some((value) => typeof value !== "string" || finiteNumber(value) === null)) {
        throw new HttpError("DeepSeek", 200);
      }
      return { currency: entry.currency, total: Number(entry.total_balance) };
    });
    const selected =
      balances.find((b) => b.currency === "USD" && b.total > 0) ??
      balances.find((b) => b.total > 0) ??
      balances.find((b) => b.currency === "USD") ??
      balances[0];
    if (!selected) return [{ ...base, blocked: true, windows: [valueWindow("bal", "$0.00")] }];
    const prefix = selected.currency === "CNY" ? "¥" : "$";
    return [
      {
        ...base,
        blocked: !data.is_available || selected.total <= 0,
        windows: [valueWindow("bal", amount(selected.total, prefix))],
      },
    ];
  },
};
