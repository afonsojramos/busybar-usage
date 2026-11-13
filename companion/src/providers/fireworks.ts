import { accountLabel, finiteNumber, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider, type RequestOptions } from "./types.ts";

const ID = "fireworks";

function base(context: Context): FeedAccount {
  return {
    provider: ID,
    account: accountLabel(null),
    blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(),
    windows: [],
  };
}

async function request(context: Context, url: string | URL, key: string, init: RequestOptions = {}): Promise<unknown> {
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

function money(value: number): string {
  return (Math.abs(value) < 1e8 ? `$${value.toFixed(2)}` : `$${value.toExponential(2)}`).slice(0, 12);
}

export const fireworks: Provider = {
  id: ID,
  name: "Fireworks",
  async fetch(context) {
    const key = await apiKey(context, ID, ["CODEXBAR_FIREWORKS_API_KEY", "FIREWORKS_API_KEY", "FIREWORKS_KEY"]);
    if (!key) throw new NotConfigured(ID);
    const entry = await providerEntry(context, ID);
    const configured =
      context.env.CODEXBAR_FIREWORKS_ACCOUNT_SLUG || context.env.FIREWORKS_ACCOUNT_SLUG || entry.accountSlug;
    const valid = (slug: string) => /^[A-Za-z0-9._-]{1,256}$/.test(slug) && slug !== "." && slug !== "..";
    if (configured != null && (typeof configured !== "string" || !valid(configured))) throw new NotConfigured(ID);
    try {
      async function discover(): Promise<string[]> {
        const slugs = new Set<string>(),
          seen = new Set<string>();
        let token = "";
        for (let page = 0; page < 100; page++) {
          const data = object(
            await request(
              context,
              `https://api.fireworks.ai/v1/accounts${token ? `?pageToken=${encodeURIComponent(token)}` : ""}`,
              key!,
            ),
          );
          if (data.accounts != null && !Array.isArray(data.accounts)) throw new HttpError(ID, 200);
          for (const raw of Array.isArray(data.accounts) ? data.accounts : []) {
            const account = object(raw);
            for (const field of ["accountId", "id", "name"])
              if (account[field] != null && typeof account[field] !== "string") throw new HttpError(ID, 200);
            const name = [account.accountId, account.id, account.name].find(
              (v): v is string => typeof v === "string" && !!v.trim(),
            );
            const slug = name?.trim().split("/").filter(Boolean).at(-1);
            if (slug && valid(slug)) slugs.add(slug);
          }
          if (data.nextPageToken != null && typeof data.nextPageToken !== "string") throw new HttpError(ID, 200);
          token = typeof data.nextPageToken === "string" ? data.nextPageToken.trim() : "";
          if (!token) return [...slugs].sort();
          if (seen.has(token)) throw new HttpError(ID, 200);
          seen.add(token);
        }
        throw new HttpError(ID, 200);
      }
      async function choose(): Promise<string> {
        const slugs = await discover();
        if (slugs.length !== 1) throw new HttpError(ID, 200);
        return slugs[0];
      }
      async function summary(slug: string): Promise<unknown> {
        const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
        const query = new URLSearchParams({ startTime: iso(context.now() - 30 * 86400), endTime: iso(context.now()) });
        return request(context, `https://api.fireworks.ai/v1/accounts/${slug}/billing/summary?${query}`, key!);
      }
      let slug = typeof configured === "string" ? configured : await choose();
      let payload: unknown;
      try {
        payload = await summary(slug);
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404 && configured)) throw error;
        slug = await choose();
        payload = await summary(slug);
      }
      const data = object(payload);
      if (data.lineItems != null && !Array.isArray(data.lineItems)) throw new HttpError(ID, 200);
      let total = 0,
        currency: string | null = null;
      for (const raw of Array.isArray(data.lineItems) ? data.lineItems : []) {
        const cost = object(raw).totalCost;
        if (cost == null) continue;
        const rated = object(cost);
        if (
          (rated.units != null && typeof rated.units !== "string") ||
          (rated.nanos != null && !Number.isSafeInteger(rated.nanos)) ||
          (rated.currencyCode != null && typeof rated.currencyCode !== "string")
        )
          throw new HttpError(ID, 200);
        if (
          typeof rated.units !== "string" ||
          !rated.units.trim() ||
          rated.nanos == null ||
          typeof rated.currencyCode !== "string" ||
          !rated.currencyCode.trim()
        )
          continue;
        const units = finiteNumber(rated.units);
        if (units === null) continue;
        currency ??= rated.currencyCode.trim();
        if (currency === rated.currencyCode.trim()) total += units + number(rated.nanos) / 1e9;
      }
      if (!Number.isFinite(total)) throw new HttpError(ID, 200);
      if (currency === null && configured && !(await discover()).includes(slug)) throw new HttpError(ID, 200);
      return finish(
        context,
        currency === null
          ? []
          : [
              valueWindow(
                "30d",
                currency.toUpperCase() === "USD" ? money(total) : `${total.toPrecision(4)} ${currency}`.slice(0, 12),
              ),
            ],
      );
    } catch (error) {
      return signIn(context, error);
    }
  },
};
