import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const ID = "munito";
const NAME = "Munito";
const fail = (): never => {
  throw new HttpError(NAME, 200);
};
function number(value: unknown, strings = true, negative = false): number {
  const parsed = strings ? finiteNumber(value) : typeof value === "number" && Number.isFinite(value) ? value : null;
  if (parsed === null || (!negative && parsed < 0)) return fail();
  return parsed;
}
function compact(value: number): string {
  const text = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
  return text.length <= 8 ? text : value.toExponential(0);
}
function money(value: number, currency = "USD"): string {
  const prefix = currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency + " ";
  const text = prefix + value.toFixed(2);
  return text.length <= 12 ? text : prefix + compact(value);
}

export const munito: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: ID,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const key = await apiKey(context, ID, ["MUNITO_API_KEY", "MUNITO_ADMIN_KEY"]);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!key) throw new NotConfigured(NAME);
    headers.Authorization = `Bearer ${key}`;
    const get = async (url: string, additions: Record<string, string> = {}): Promise<unknown> => {
      const response = await context.fetch(url, {
        headers: { ...headers, ...additions },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited(NAME, now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError(NAME, response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError(NAME, response.status);
      }
    };
    try {
      const body = await get("https://api.munito.ai/admin/v1/limits");
      if (!isRecord(body)) return fail();
      const windows: FeedWindow[] = [];
      if (!Array.isArray(body.periods)) return fail();
      const periods = new Map<string, { spent: number; limit: number | null; stopped: number | null }>();
      for (const raw of body.periods) {
        if (!isRecord(raw)) return fail();
        if (raw.period !== "day" && raw.period !== "month") continue;
        const amount = (value: unknown) => {
          if (typeof value === "string" && !/^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return fail();
          return number(value);
        };
        const spent = amount(raw.spent_usd);
        const limit = raw.limit_usd == null ? null : amount(raw.limit_usd);
        for (const field of ["organization_limit_usd", "account_limit_usd"]) if (raw[field] != null) amount(raw[field]);
        const stopped = isoToSeconds(raw.stopped_until);
        if (
          raw.stopped_until != null &&
          (stopped === null ||
            typeof raw.stopped_until !== "string" ||
            !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw.stopped_until))
        )
          return fail();
        if (!periods.has(raw.period)) periods.set(raw.period, { spent, limit, stopped });
      }
      for (const [kind, minutes] of [
        ["day", 1440],
        ["month", 43200],
      ] satisfies [string, number][]) {
        const period = periods.get(kind);
        if (!period) continue;
        if (period.stopped !== null && period.stopped > now) base.blocked = true;
        windows.push(
          period.limit !== null && period.limit > 0
            ? feedWindow(minutes, Math.min(100, (period.spent / period.limit) * 100), null, now)
            : valueWindow(kind === "day" ? "Today" : "30d", money(period.spent)),
        );
      }
      // Organization enrichment is optional; failed metadata never discards spend limits.
      try {
        await get("https://api.munito.ai/admin/v1/organization");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
      }
      return [
        {
          ...base,
          blocked: base.blocked || windows.some((w) => (w.used_percent ?? 0) >= 100),
          windows,
        },
      ];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};

class SignIn extends Error {}
