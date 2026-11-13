import {
  accountLabel,
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
} from "./types.ts";

const ID = "tripo";
const NAME = "Tripo";
const fail = (): never => {
  throw new HttpError(NAME, 200);
};
function number(value: unknown, strings = true, negative = false): number {
  const parsed = strings
    ? finiteNumber(value)
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : null;
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

export const tripo: Provider = {
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
    const key = await apiKey(context, ID, ["TRIPO_API_KEY"]);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!key) throw new NotConfigured(NAME);
    headers.Authorization = `Bearer ${key}`;
    const get = async (
      url: string,
      additions: Record<string, string> = {},
    ): Promise<unknown> => {
      const response = await context.fetch(url, {
        headers: { ...headers, ...additions },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403)
        throw new SignIn();
      if (response.status === 429)
        throw new RateLimited(
          NAME,
          now + retryAfterSeconds(response.headers, 300),
        );
      if (!response.ok) throw new HttpError(NAME, response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError(NAME, response.status);
      }
    };
    try {
      const body = await get("https://openapi.tripo3d.ai/v3/account/balance");
      if (!isRecord(body)) return fail();
      const windows: FeedWindow[] = [];
      if (body.code !== 0 || !isRecord(body.data)) return fail();
      const balance = number(body.data.balance, false);
      const frozen = number(body.data.frozen, false);
      windows.push(
        valueWindow("Balance", compact(balance) + " cr"),
        valueWindow("Reserved", compact(frozen) + " cr"),
      );
      base.blocked = balance === 0;
      return [
        {
          ...base,
          blocked:
            base.blocked || windows.some((w) => (w.used_percent ?? 0) >= 100),
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
