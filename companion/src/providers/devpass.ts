import {
  accountLabel,
  feedWindow,
  valueWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "devpass";
const NAME = "DevPass";
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
  const key = await apiKey(context, ID, ["DEVPASS_API_KEY"]);
  if (!key) throw new NotConfigured(NAME);
  const data = object((await read(context, "https://api.llmgateway.io/v1/key", key)).data);
  if (!["none", "lite", "pro", "max"].includes(String(data.devPlan))) return fail();
  const nonnegative = (value: unknown) => {
    const n = money(value);
    return n >= 0 ? n : fail();
  };
  const spent = nonnegative(data.usage);
  if (data.limit !== null) nonnegative(data.limit);
  if (data.devPlan === "none") return account(context, [valueWindow("spent", usd(spent))]);
  const used = nonnegative(data.devPlanCreditsUsed),
    limit = nonnegative(data.devPlanCreditsLimit);
  nonnegative(data.devPlanCreditsRemaining);
  const weekly = nonnegative(data.devPlanPremiumCreditsUsed),
    weeklyLimit = nonnegative(data.devPlanPremiumWeeklyLimit);
  const reset = data.devPlanPremiumWeekResetsAt === null ? null : isoToSeconds(data.devPlanPremiumWeekResetsAt);
  if (data.devPlanPremiumWeekResetsAt !== null && reset === null) return fail();
  const windows: FeedWindow[] = [];
  if (weeklyLimit > 0) windows.push(feedWindow(10080, (weekly / weeklyLimit) * 100, reset, context.now()));
  if (limit > 0) windows.push(feedWindow(null, (used / limit) * 100, null, context.now(), "cycle"));
  return account(context, windows);
}
export const devpass: Provider = {
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
