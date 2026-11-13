import { accountLabel, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "aiand";
const NAME = "ai&";
function fail(): never {
  throw new HttpError(NAME, 200);
}
function object(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : fail();
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
function decimalAmount(raw: string): { coefficient: bigint; scale: number } | null {
  const match = raw.trim().match(/^([+-]?)(\d+(?:\.\d*)?|\.\d+)(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const mantissa = match[2]!.replace(/(\.\d*?)0+$/, "$1");
  const exponent = Number(match[3] ?? 0),
    scale = (mantissa.split(".")[1]?.length ?? 0) - exponent;
  if (!Number.isInteger(scale) || exponent < -128 || exponent > 127 || scale > 128) return null;
  return { coefficient: BigInt(`${match[1] === "-" ? "-" : ""}${mantissa.replace(".", "")}`), scale };
}
async function execute(context: Context): Promise<FeedAccount[]> {
  const key = await apiKey(context, ID, ["AIAND_API_KEY"]);
  if (!key) throw new NotConfigured(NAME);
  let after: string | null = null,
    afterId: string | null = null,
    currency: string | null = null;
  let coefficient = 0n,
    scale = 0,
    complete = false;
  for (let page = 0; page < 10; page++) {
    let url = "https://api.aiand.com/logs?range=30days&limit=100";
    if (after !== null && afterId !== null)
      url += `&after=${encodeURIComponent(after)}&after_id=${encodeURIComponent(afterId)}`;
    const data = await read(context, url, key);
    if (!Array.isArray(data.data) || (data.has_more != null && typeof data.has_more !== "boolean")) return fail();
    const cursor = (value: unknown) => (value == null ? null : typeof value === "string" ? value : fail());
    after = cursor(data.next_after);
    afterId = cursor(data.next_after_id);
    for (const value of data.data) {
      const row = object(value),
        cost = cursor(row.cost),
        code = cursor(row.currency)?.trim().toUpperCase();
      const decimal = cost === null ? null : decimalAmount(cost);
      if (!decimal || !code) continue;
      currency ??= code;
      if (code !== currency) continue;
      const nextScale = Math.max(scale, decimal.scale);
      coefficient =
        coefficient * 10n ** BigInt(nextScale - scale) + decimal.coefficient * 10n ** BigInt(nextScale - decimal.scale);
      scale = nextScale;
    }
    if (!data.has_more) {
      complete = true;
      break;
    }
    if (after === null || afterId === null) break;
  }
  const total = Number(`${coefficient}e${-scale}`);
  if (!Number.isFinite(total)) return fail();
  const value = currency === "USD" ? usd(total) : `${currency} ${total.toFixed(2)}`;
  return account(
    context,
    currency
      ? [
          valueWindow(
            complete ? "30d" : "30d part",
            value.length <= 12 ? value : `${currency} ${total.toExponential(1)}`.slice(0, 12),
          ),
        ]
      : [],
  );
}
export const aiand: Provider = {
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
