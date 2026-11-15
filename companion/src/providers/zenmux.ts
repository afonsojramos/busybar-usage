import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  type Context,
  type Provider,
  type RequestOptions,
} from "./types.ts";

const ID = "zenmux";

function base(context: Context): FeedAccount {
  return {
    provider: ID,
    account: accountLabel(null),
    blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(),
    windows: [],
  };
}

async function request(context: Context, url: string | URL, key: string, init: RequestOptions = {}): Promise<unknown> {
  const response = await context.fetch(url, {
    ...init,
    redirect: "error",
    headers: { Accept: "application/json", Authorization: `Bearer ${key}`, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403) throw new HttpError(ID, response.status);
  if (response.status === 429) throw new RateLimited(ID, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(ID, response.status);
  try {
    return await response.json();
  } catch {
    throw new HttpError(ID, response.status);
  }
}

function finish(context: Context, windows: FeedWindow[], blocked = false): FeedAccount[] {
  return [
    {
      ...base(context),
      windows: windows.slice(0, 2),
      blocked: blocked || windows.some((window) => (window.used_percent ?? 0) >= 100),
    },
  ];
}

function signIn(context: Context, error: unknown): FeedAccount[] {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return [{ ...base(context), error: "sign in" }];
  }
  throw error;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(ID, 200);
  return value;
}

function number(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null) throw new HttpError(ID, 200);
  return parsed;
}

export const zenmux: Provider = {
  id: ID,
  name: "ZenMux",
  async fetch(context) {
    const key = await apiKey(context, ID, ["ZENMUX_MANAGEMENT_API_KEY"]);
    if (!key) throw new NotConfigured(ID);
    try {
      const root = object(await request(context, "https://zenmux.ai/api/v1/management/subscription/detail", key));
      if (root.success !== true) throw new HttpError(ID, 200);
      const data = object(root.data);
      if (typeof object(data.plan).tier !== "string" || typeof data.account_status !== "string")
        throw new HttpError(ID, 200);
      const windows = [
        ["quota_5_hour", 300],
        ["quota_7_day", 10080],
      ].map(([field, minutes]) => {
        const quota = object(data[String(field)]);
        for (const name of ["usage_percentage", "max_flows", "used_flows", "remaining_flows"]) {
          if (typeof quota[name] !== "number" || !Number.isFinite(quota[name])) throw new HttpError(ID, 200);
        }
        if (quota.resets_at != null && typeof quota.resets_at !== "string") throw new HttpError(ID, 200);
        return feedWindow(
          Number(minutes),
          Math.max(0, Math.min(100, number(quota.usage_percentage) * 100)),
          isoToSeconds(quota.resets_at),
          context.now(),
        );
      });
      return finish(context, windows);
    } catch (error) {
      return signIn(context, error);
    }
  },
};
