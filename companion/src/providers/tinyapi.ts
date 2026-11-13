import { accountLabel, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "tinyapi";
const NAME = "TinyApi";
const invalid = (): never => { throw new HttpError(NAME, 200); };
const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : invalid();
const numeric = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : invalid();
const compact = (value: number): string => Math.abs(value) >= 1e12 ? value.toExponential(1) : new Intl.NumberFormat("en-US", {
  notation: "compact", maximumFractionDigits: 2,
}).format(value);

async function request(context: Context, url: string, headers: Record<string, string>, body?: unknown,
  signal = AbortSignal.timeout(30_000)): Promise<unknown> {
  const response = await context.fetch(url, {
    method: body === undefined ? "GET" : "POST", redirect: "manual",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try { return await response.json(); } catch { throw new HttpError(NAME, response.status); }
}

export const tinyapi: Provider = {
  id: ID, name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, ID);
    if (entry.cookieSource === "off") throw new NotConfigured(NAME);
    const base: FeedAccount = {
      provider: ID, account: accountLabel(null), blocked: false,
      observed_at: new Date(context.now() * 1000).toISOString(), windows: [],
    };
    const cookie = await cookieHeader(context, ID, { domains: ["tinyapi.rest"] });
    if (!cookie) throw new NotConfigured(NAME);
    try {
      const payload = object(await request(context, "https://tinyapi.rest/api/user/credits", { Cookie: cookie }));
      const balance = numeric(object(payload.data).totalAvailable);
      if (payload.success !== true || balance < 0) return invalid();
      return [{ ...base, blocked: balance === 0, windows: [valueWindow("Credits", `${compact(balance)} cr`)] }];
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
