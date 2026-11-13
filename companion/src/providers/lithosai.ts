import { accountLabel, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "lithosai";
const NAME = "LithosAI";
const invalid = (): never => {
  throw new HttpError(NAME, 200);
};
const object = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : invalid());
const numeric = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : invalid());
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const compact = (value: number): string =>
  Math.abs(value) >= 1e12
    ? value.toExponential(1)
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);
const money = (value: number): string =>
  value > 0 && value < 0.01 ? "<$0.01" : Math.abs(value) < 1e8 ? `$${value.toFixed(2)}` : `$${compact(value)}`;

async function request(
  context: Context,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  signal = AbortSignal.timeout(30_000),
): Promise<unknown> {
  const response = await context.fetch(url, {
    method: body === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try {
    return await response.json();
  } catch {
    throw new HttpError(NAME, response.status);
  }
}

export const lithosai: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, ID);
    if (entry.cookieSource === "off") throw new NotConfigured(NAME);
    const base: FeedAccount = {
      provider: ID,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(context.now() * 1000).toISOString(),
      windows: [],
    };
    const cookie = await cookieHeader(context, ID, {
      domains: ["console.lithosai.cloud"],
      required: ["__Host-console_session", "__Host-console_csrf"],
    });
    if (!cookie) throw new NotConfigured(NAME);
    const csrf = /(?:^|;\s*)__Host-console_csrf=([^;]+)/.exec(cookie)?.[1];
    if (!csrf || !/(?:^|;\s*)__Host-console_session=([^;]+)/.test(cookie)) throw new NotConfigured(NAME);
    const headers: Record<string, string> = { Cookie: cookie, "X-Console-Csrf": csrf };
    try {
      const me = object(await request(context, "https://console.lithosai.cloud/api/me", headers));
      base.account = accountLabel(text(object(me.user).email));
      const org = text(object(me.activeOrganization).id);
      if (!org || !/^[A-Za-z0-9_-]{1,128}$/.test(org)) return invalid();
      headers["X-Organization-Id"] = org;
      const billing = object(await request(context, "https://console.lithosai.cloud/api/billing", headers));
      const nanos = numeric(billing.balanceNanos);
      if (!Number.isSafeInteger(nanos) || typeof billing.hasCard !== "boolean" || typeof billing.onHold !== "boolean")
        return invalid();
      const balance = nanos / 1e9;
      return [{ ...base, blocked: billing.onHold || balance <= 0, windows: [valueWindow("Balance", money(balance))] }];
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
