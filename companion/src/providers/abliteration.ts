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
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const ID = "abliteration";
const NAME = "abliteration.ai";
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

export const abliteration: Provider = {
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
    const key = await apiKey(context, ID, ["ABLITERATION_API_KEY"]);
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
      const body = await get("https://api.abliteration.ai/v1/credits");
      if (!isRecord(body)) return fail();
      const windows: FeedWindow[] = [];
      if (!isRecord(body.data)) return fail();
      const total = number(body.data.total_credits, false);
      const used = number(body.data.total_usage, false);
      if (total > 0) windows.push(feedWindow(null, Math.min(100, (used / total) * 100), null, now, "Credits"));
      windows.push(valueWindow("Balance", money(Math.max(0, total - used))));
      if (total === 0) windows.push(valueWindow("Spent", money(used)));
      base.blocked = used >= total;
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
