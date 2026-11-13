import { accountLabel, feedWindow, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "xkiro";
const NAME = "xKiro";
function fail(): never { throw new HttpError(NAME, 200); }
function object(value: unknown): Record<string, unknown> { return isRecord(value) ? value : fail(); }
function account(context: Context, windows: FeedWindow[], email?: unknown): FeedAccount[] {
  return [{
    provider: ID, account: accountLabel(typeof email === "string" ? email : null),
    observed_at: new Date(context.now() * 1000).toISOString(), windows,
    blocked: windows.some(w => (w.used_percent ?? 0) >= 100)
  }];
}
async function read(context: Context, url: string, key: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await context.fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...headers },
    redirect: "error", signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try { return object(await response.json()); } catch { throw new HttpError(NAME, response.status); }
}

async function execute(context: Context): Promise<FeedAccount[]> {
  const key = await apiKey(context, ID, ["XKIRO_API_KEY"]);
  if (!key) throw new NotConfigured(NAME);
  const data = await read(context, "https://api.xkiro.com/v1/usage", key);
  if (data.object !== "usage") return fail();
  const free = object(data.free_tokens);
  const counter = (value: unknown): number | null => {
    if (value == null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail();
    return value;
  };
  const used = counter(free.used_today), limit = counter(free.limit_per_day), remaining = counter(free.remaining);
  if (used === null && limit === null && remaining === null && free.limit_per_day !== null) return fail();
  const reset = (Math.floor(context.now() / 86400) + 1) * 86400;
  const windows = used !== null && limit !== null
    ? [feedWindow(1440, limit === 0 ? 100 : used / limit * 100, reset, context.now())]
    : remaining !== null ? [valueWindow("tokens", `${remaining}`.slice(0, 12))] : [];
  return account(context, windows, isRecord(data.user) ? data.user.email : null);
}
export const xkiro: Provider = {
  id: ID, name: NAME, async fetch(context) {
    try { return await execute(context); } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403))
        return account(context, []).map(a => ({ ...a, error: "sign in" }));
      throw error;
    }
  }
};
