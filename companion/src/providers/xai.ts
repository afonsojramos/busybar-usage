import {
  accountLabel,
  valueWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "xai";
const NAME = "xAI";
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
  body?: unknown,
): Promise<Record<string, unknown>> {
  const response = await context.fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...headers },
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
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
  const key = (await apiKey(context, ID, ["XAI_MANAGEMENT_API_KEY"]))?.replace(/^(["'])(.*)\1$/, "$2").trim();
  if (!key) throw new NotConfigured(NAME);
  const entry = await providerEntry(context, ID);
  const rawTeam = context.env.XAI_TEAM_ID || entry.workspaceID;
  const team =
    typeof rawTeam === "string"
      ? rawTeam
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2")
          .trim()
      : null;
  if (typeof team !== "string" || !team.trim() || team.includes("/") || team === "." || team === "..")
    throw new NotConfigured(NAME);
  const root = `https://management-api.x.ai/v1/billing/teams/${encodeURIComponent(team)}`;
  const data = await read(context, `${root}/prepaid/balance`, key);
  const balance = -money(object(data.total).val) / 100;
  const windows = [valueWindow("posted", usd(balance))];
  // The invoice preview is optional enrichment; its failure must preserve posted credit.
  try {
    const preview = await read(context, `${root}/postpaid/invoice/preview`, key);
    const cents = object(preview.coreInvoice).amountAfterVat;
    if (typeof cents === "string" && /^-?\d+$/.test(cents) && Number.isSafeInteger(Number(cents)))
      windows.push(valueWindow("live est", usd(balance - Number(cents) / 100)));
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
  }
  // History is optional and only fills a lane when the live estimate is unavailable.
  try {
    const now = new Date(context.now() * 1000),
      start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 29);
    start.setUTCHours(0, 0, 0, 0);
    const timestamp = (date: Date) => date.toISOString().slice(0, 19).replace("T", " ");
    const history = await read(
      context,
      `${root}/usage`,
      key,
      { "Content-Type": "application/json" },
      {
        analyticsRequest: {
          timeRange: { startTime: timestamp(start), endTime: timestamp(now), timezone: "Etc/GMT" },
          timeUnit: "TIME_UNIT_DAY",
          values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
          groupBy: [],
          filters: [],
        },
      },
    );
    if (!Array.isArray(history.timeSeries)) return fail();
    let total = 0;
    for (const series of history.timeSeries) {
      const data = object(series);
      if (!Array.isArray(data.dataPoints)) return fail();
      for (const value of data.dataPoints) {
        const point = object(value);
        if (
          !Array.isArray(point.values) ||
          typeof point.values[0] !== "number" ||
          point.values[0] < 0 ||
          !Number.isFinite(point.values[0]) ||
          typeof point.timestamp !== "string" ||
          isoToSeconds(point.timestamp) === null
        )
          return fail();
        total += point.values[0];
      }
    }
    if (!Number.isFinite(total)) return fail();
    if (windows.length < 2)
      windows.push(valueWindow(history.limitReached === true ? "30d part" : "30d spent", usd(total)));
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
  }
  return account(context, windows);
}
export const xai: Provider = {
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
