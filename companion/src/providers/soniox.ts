import { accountLabel, feedWindow, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const soniox: Provider = {
  id: "soniox",
  name: "Soniox",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "soniox", ["SONIOX_ORG_API_KEY"]);
    if (!key) throw new NotConfigured("Soniox");
    const now = context.now();
    const base: FeedAccount = {
      provider: "soniox",
      provider_name: "Soniox",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const headers = { Authorization: `Bearer ${key}` };
    const response = await context.fetch("https://api.soniox.com/v1/organization/balance", {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Soniox", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Soniox", response.status);
    const fail = (): never => {
      throw new HttpError("Soniox", response.status);
    };
    const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : fail());
    const number = (value: unknown, signed = false): number =>
      typeof value === "number" && Number.isFinite(value) && (signed || value >= 0) ? value : fail();
    const compact = (value: number): string => {
      const text = new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);
      return text.length <= 8 ? text : value.toExponential(0);
    };
    const dollars = (value: number): string => {
      const text = `$${value.toFixed(2)}`;
      return text.length <= 12 ? text : `$${compact(value)}`;
    };
    let data: Record<string, unknown>;
    try {
      data = record(await response.json());
    } catch {
      return fail();
    }
    const windows: FeedWindow[] = [];
    const money = (raw: unknown, signed = false): number => {
      if (typeof raw !== "string" || !/^-?\d+(?:\.\d+)?$/.test(raw.trim())) return fail();
      return number(Number(raw), signed);
    };
    const balance = money(data.available_balance_usd, true);
    if (typeof data.invoice_billing_enabled !== "boolean") fail();
    const monthlyResponse = await context.fetch("https://api.soniox.com/v1/organization/usage/monthly", {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (monthlyResponse.status === 401 || monthlyResponse.status === 403) return [{ ...base, error: "sign in" }];
    if (monthlyResponse.status === 429)
      throw new RateLimited("Soniox", now + retryAfterSeconds(monthlyResponse.headers, 300));
    if (!monthlyResponse.ok) throw new HttpError("Soniox", monthlyResponse.status);
    let monthly: Record<string, unknown>;
    try {
      monthly = record(await monthlyResponse.json());
    } catch {
      return fail();
    }
    const used = money(monthly.usage_usd);
    const budget = money(monthly.monthly_budget_usd);
    if (typeof monthly.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthly.month)) fail();
    const reset = new Date(`${String(monthly.month)}-01T00:00:00Z`);
    reset.setUTCMonth(reset.getUTCMonth() + 1);
    windows.push(
      budget > 0
        ? feedWindow(43200, Math.min(100, (used / budget) * 100), reset.getTime() / 1000, now)
        : valueWindow("spend", dollars(used)),
    );
    if (!data.invoice_billing_enabled) windows.push(valueWindow("balance", dollars(balance)));
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
