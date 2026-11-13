import { accountLabel, valueWindow, finiteNumber, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "atlascloud";
const NAME = "Atlas Cloud";
function fail(): never {
  throw new HttpError(NAME, 200);
}
function object(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : fail();
}
function number(value: unknown): number {
  return finiteNumber(value) ?? fail();
}
function money(value: unknown): number {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) return fail();
  return number(value);
}
function usd(value: number): string {
  const text = `$${value.toFixed(2)}`;
  return text.length <= 12 ? text : `$${value.toExponential(3)}`;
}
function account(context: Context, windows: FeedWindow[], email?: unknown): FeedAccount[] {
  return [
    {
      provider: ID,
      account: accountLabel(typeof email === "string" ? email : null),
      observed_at: new Date(context.now() * 1000).toISOString(),
      windows,
      blocked: windows.some((w) => (w.used_percent ?? 0) >= 100),
    },
  ];
}
async function read(
  context: Context,
  url: string,
  key: string,
  headers: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await context.fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...headers },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try {
    return object(await response.json());
  } catch {
    throw new HttpError(NAME, response.status);
  }
}

async function execute(context: Context): Promise<FeedAccount[]> {
  const key = await apiKey(context, ID, ["ATLASCLOUD_API_KEY"]);
  if (!key) throw new NotConfigured(NAME);
  const data = await read(context, "https://api.atlascloud.ai/public/v1/balance", key);
  const available = object(data.available);
  if (data.object !== "balance" || data.scope !== "account" || available.currency !== "usd") return fail();
  return account(context, [valueWindow("balance", usd(money(available.value)))]);
}
export const atlascloud: Provider = {
  id: ID,
  name: NAME,
  async fetch(context) {
    try {
      return await execute(context);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403))
        return account(context, []).map((a) => ({ ...a, error: "sign in" }));
      throw error;
    }
  },
};
