import {
  accountLabel,
  finiteNumber,
  isoToSeconds,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "poe";

function base(context: Context): FeedAccount {
  return {
    provider: ID,
    account: accountLabel(null),
    blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(),
    windows: [],
  };
}

async function request(context: Context, url: string | URL, key: string, init: RequestInit = {}): Promise<unknown> {
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

function compact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function timestamp(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null) {
    const seconds = numeric > 1e14 ? numeric / 1e6 : numeric > 1e12 ? numeric / 1000 : numeric;
    return Number.isFinite(new Date(seconds * 1000).getTime()) ? seconds : null;
  }
  return isoToSeconds(value);
}

export const poe: Provider = {
  id: ID,
  name: "Poe",
  async fetch(context) {
    const key = await apiKey(context, ID, ["POE_API_KEY"]);
    if (!key) throw new NotConfigured(ID);
    try {
      const data = object(await request(context, "https://api.poe.com/usage/current_balance", key));
      const balance = data.current_point_balance == null ? null : number(data.current_point_balance);
      let points = 0,
        entries = 0;
      try {
        let cursor = "";
        for (let page = 0; page < 5; page++) {
          const root = object(
            await request(
              context,
              `https://api.poe.com/usage/points_history?limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`,
              key,
            ),
          );
          const rows = [root.data, root.items, root.results].find(Array.isArray) ?? [];
          let lastDate: number | null = null;
          for (const raw of rows) {
            if (!isRecord(raw)) continue;
            const date = timestamp(raw.creation_time ?? raw.timestamp ?? raw.created_at);
            lastDate = date;
            if (date === null || date < context.now() - 30 * 86400) continue;
            const used = raw.cost_points ?? raw.points ?? raw.point_cost;
            points += Math.max(0, used == null ? 0 : number(used));
            entries++;
          }
          const last: unknown = rows.at(-1);
          cursor =
            typeof root.next_cursor === "string" && root.next_cursor.trim()
              ? root.next_cursor.trim()
              : root.has_more === true && isRecord(last) && typeof last.query_id === "string"
                ? last.query_id.trim()
                : "";
          if (!cursor || (lastDate !== null && lastDate < context.now() - 30 * 86400)) break;
        }
      } catch (error) {
        if (
          error instanceof RateLimited ||
          (error instanceof HttpError && [401, 403].includes(error.status)) ||
          (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
        )
          throw error;
      }
      const windows: FeedWindow[] = [];
      if (balance !== null) windows.push(valueWindow("points", `${compact(balance)} pt`.slice(0, 12)));
      if (entries) windows.push(valueWindow("30d", `${compact(points)} pt`.slice(0, 12)));
      return finish(context, windows, balance !== null && balance <= 0);
    } catch (error) {
      return signIn(context, error);
    }
  },
};
