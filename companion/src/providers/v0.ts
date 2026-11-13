import { accountLabel, feedWindow, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "v0";
const NAME = "v0";
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
  const key = await apiKey(context, ID, ["V0_API_KEY"]);
  if (!key) throw new NotConfigured(NAME);
  const entry = await providerEntry(context, ID);
  const scope = context.env.V0_SCOPE || (typeof entry.workspaceID === "string" ? entry.workspaceID : "");
  const query = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const billing = await read(context, `https://api.v0.dev/v1/user/billing${query}`, key);
  const data = object(billing.data);
  if (billing.billingType !== "token" && billing.billingType !== "legacy") return fail();
  const quota = (limitRaw: unknown, remainingRaw: unknown, resetRaw: unknown, name: string): FeedWindow => {
    const strict = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : fail();
    const limit = strict(limitRaw);
    if (limit < 0) return fail();
    let reset: number | null = null;
    if (resetRaw != null) { const n = strict(resetRaw); reset = n > 0 ? n / (n >= 1e12 ? 1000 : 1) : null; }
    if (remainingRaw == null) return valueWindow(name, "Unavailable", reset);
    const remaining = strict(remainingRaw);
    return feedWindow(null, limit === 0 ? 0 : Math.max(0, limit - remaining) / limit * 100, reset, context.now(), name);
  };
  let billingWindow: FeedWindow;
  if (billing.billingType === "token") {
    const balance = object(data.balance), cycle = object(data.billingCycle);
    if (typeof balance.total !== "number" || typeof balance.remaining !== "number") return fail();
    billingWindow = quota(balance.total, balance.remaining, cycle.end, "billing");
    if (data.onDemand != null) {
      const onDemand = object(data.onDemand);
      if (typeof onDemand.balance !== "number" || !Number.isFinite(onDemand.balance)) return fail();
    }
  } else billingWindow = quota(data.limit, data.remaining, data.reset, "billing");
  const rate = await read(context, `https://api.v0.dev/v1/rate-limits${query}`, key);
  return account(context, [quota(rate.limit, rate.remaining, rate.reset, "rate"), billingWindow]);
}
export const v0: Provider = {
  id: ID, name: NAME, async fetch(context) {
    try { return await execute(context); } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403))
        return account(context, []).map(a => ({ ...a, error: "sign in" }));
      throw error;
    }
  }
};
