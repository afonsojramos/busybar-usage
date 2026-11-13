import {
  accountLabel,
  feedWindow,
  isRecord,
  isoToSeconds,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "claudeplatform";
const NAME = "Claude Platform";
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

export const claudeplatform: Provider = {
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
    const cookie = await cookieHeader(context, ID, { domains: ["platform.claude.com"], required: ["sessionKey"] });
    if (!cookie) throw new NotConfigured(NAME);
    const headers = { Cookie: cookie };
    try {
      const raw = await request(context, "https://platform.claude.com/api/organizations", headers);
      if (!Array.isArray(raw)) return invalid();
      let credits: Record<string, unknown> | null = null;
      for (const item of raw) {
        const org = object(item);
        if (!Array.isArray(org.capabilities) || !org.capabilities.includes("api")) continue;
        const id = text(org.uuid);
        if (!id || !/^[A-Za-z0-9-]{1,64}$/.test(id)) return invalid();
        try {
          credits = object(
            await request(context, `https://platform.claude.com/api/organizations/${id}/prepaid/credits`, headers),
          );
          break;
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 403)) throw error;
        }
      }
      if (!credits) return [{ ...base, error: "sign in" }];
      const currency = text(credits.currency) ?? "USD";
      if (!/^[A-Z]{3}$/.test(currency)) return invalid();
      const exponent = credits.balance == null ? 2 : (object(object(credits.balance).credits ?? {}).exponent ?? 2);
      if (typeof exponent !== "number" || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) return invalid();
      const amount = numeric(credits.amount);
      if (!Number.isSafeInteger(amount)) return invalid();
      const balance = amount / 10 ** exponent;
      const formatted = currency === "USD" ? money(balance) : `${compact(balance)} ${currency}`;
      const windows: FeedWindow[] = [valueWindow("Balance", formatted)];
      const grants: {
        purchased: boolean;
        program: unknown;
        remaining: number;
        granted: number;
        expiry: number | null;
      }[] = [];
      for (const field of ["promo_tranches", "tranches"]) {
        const list = credits[field];
        if (list == null) continue;
        if (!Array.isArray(list)) return invalid();
        for (const item of list) {
          const grant = object(item);
          const granted = numeric(grant.granted_amount_minor_units),
            remaining = numeric(grant.remaining_amount_minor_units);
          if (!Number.isSafeInteger(granted) || !Number.isSafeInteger(remaining)) return invalid();
          const expiry =
            typeof grant.expires_at === "string" && /^\d{4}-\d{2}-\d{2}T/.test(grant.expires_at)
              ? isoToSeconds(grant.expires_at)
              : null;
          if (granted <= 0 || (expiry !== null && expiry <= context.now())) continue;
          grants.push({
            purchased: field === "tranches",
            program: grant.program_id,
            remaining: Math.max(0, remaining),
            granted,
            expiry,
          });
        }
      }
      grants.sort((a, b) => (a.expiry ?? Infinity) - (b.expiry ?? Infinity));
      const grant =
        grants.find((g) => g.program === "subscription_api_credit" && g.remaining > 0) ??
        grants.find((g) => g.purchased && g.remaining > 0) ??
        grants.find((g) => g.purchased);
      // Grant expiry removes credits; it does not refill the allowance.
      if (grant)
        windows.push(
          feedWindow(
            null,
            Math.min(100, Math.max(0, (1 - grant.remaining / grant.granted) * 100)),
            null,
            context.now(),
            grant.purchased ? "Bought" : "API",
          ),
        );
      return [{ ...base, blocked: balance <= 0 || windows.some((w) => (w.used_percent ?? 0) >= 100), windows }];
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
