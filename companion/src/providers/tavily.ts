import { accountLabel, feedWindow, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const tavily: Provider = {
  id: "tavily",
  name: "Tavily",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "tavily", ["TAVILY_API_KEY"]);
    if (!key) throw new NotConfigured("Tavily");
    const now = context.now();
    const base: FeedAccount = {
      provider: "tavily",
      provider_name: "Tavily",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const headers = { Authorization: `Bearer ${key}` };
    const response = await context.fetch("https://api.tavily.com/usage", {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Tavily", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Tavily", response.status);
    const fail = (): never => {
      throw new HttpError("Tavily", response.status);
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
    const account = record(data.account);
    const keyUsage = record(data.key);
    const used = integer(account.plan_usage);
    const limit = integer(account.plan_limit);
    const keyUsed = integer(keyUsage.usage);
    const keyLimit = keyUsage.limit === null ? null : integer(keyUsage.limit);
    if (account.paygo_usage !== undefined || account.paygo_limit !== undefined) {
      integer(account.paygo_usage);
      if (account.paygo_limit !== null) integer(account.paygo_limit);
    }
    if (
      account.current_plan !== undefined &&
      (typeof account.current_plan !== "string" || !account.current_plan.trim() || account.current_plan.length > 120)
    )
      fail();
    windows.push(
      limit > 0
        ? feedWindow(43200, Math.min(100, (used / limit) * 100), null, now)
        : valueWindow("plan", `${compact(used)} cr`),
    );
    windows.push(
      keyLimit !== null && keyLimit > 0
        ? feedWindow(null, Math.min(100, (keyUsed / keyLimit) * 100), null, now, "key")
        : valueWindow("key", `${compact(keyUsed)} cr`),
    );
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
