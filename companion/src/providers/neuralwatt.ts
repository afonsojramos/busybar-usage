import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  isProviderHost,
  type Context,
  type Provider, type RequestOptions } from "./types.ts";

const ID = "neuralwatt";

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

function endpoint(raw: string, hosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new NotConfigured(ID);
  }
  if (!isProviderHost(url, hosts) || url.username || url.password) throw new NotConfigured(ID);
  return url;
}

export const neuralwatt: Provider = {
  id: ID,
  name: "Neuralwatt",
  async fetch(context) {
    const key = await apiKey(context, ID, ["NEURALWATT_API_KEY"]);
    if (!key) throw new NotConfigured(ID);
    const url = endpoint(context.env.NEURALWATT_API_URL || "https://api.neuralwatt.com", ["api.neuralwatt.com"]);
    url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/v1/quota`;
    try {
      const root = object(await request(context, url, key));
      const balance = object(root.balance);
      for (const field of ["credits_remaining_usd", "total_credits_usd", "credits_used_usd"]) {
        if (balance[field] != null && (typeof balance[field] !== "number" || !Number.isFinite(balance[field])))
          throw new HttpError(ID, 200);
      }
      let remaining = finiteNumber(balance.credits_remaining_usd);
      const total = finiteNumber(balance.total_credits_usd),
        used = finiteNumber(balance.credits_used_usd);
      if (remaining === null && total !== null && used !== null) remaining = Math.max(0, total - used);
      if (remaining !== null && remaining < 0) remaining = null;
      if (remaining === null && !(used !== null && used >= 0) && !(total !== null && total > 0))
        throw new HttpError(ID, 200);
      const sub = root.subscription == null ? {} : object(root.subscription);
      for (const field of ["kwh_included", "kwh_used", "kwh_remaining"]) {
        if (sub[field] != null && (typeof sub[field] !== "number" || !Number.isFinite(sub[field])))
          throw new HttpError(ID, 200);
      }
      for (const field of ["current_period_start", "current_period_end"]) {
        if (sub[field] != null && isoToSeconds(sub[field]) === null) throw new HttpError(ID, 200);
      }
      const positive = (n: number | null) => (n !== null && n > 0 ? n : null);
      const nonnegative = (n: number | null) => (n !== null && n >= 0 ? n : null);
      const kwhUsed = nonnegative(finiteNumber(sub.kwh_used)),
        kwhRemaining = nonnegative(finiteNumber(sub.kwh_remaining));
      const included =
        positive(finiteNumber(sub.kwh_included)) ??
        (kwhUsed !== null && kwhRemaining !== null ? positive(kwhUsed + kwhRemaining) : null);
      const consumed =
        kwhUsed ?? (included !== null && kwhRemaining !== null ? Math.max(0, included - kwhRemaining) : null);
      const windows: FeedWindow[] = [];
      if (included !== null && consumed !== null) {
        const start = isoToSeconds(sub.current_period_start),
          end = isoToSeconds(sub.current_period_end);
        const minutes =
          start !== null && end !== null && end > start ? Math.max(1, Math.trunc((end - start) / 60)) : null;
        windows.push(
          feedWindow(minutes, (consumed / included) * 100, end, context.now(), minutes === null ? "kWh" : undefined),
        );
      }
      const keyData = root.key == null ? {} : object(root.key);
      const allowance = keyData.allowance == null ? {} : object(keyData.allowance);
      for (const field of ["spent_usd", "limit_usd", "remaining_usd"]) {
        if (allowance[field] != null && (typeof allowance[field] !== "number" || !Number.isFinite(allowance[field])))
          throw new HttpError(ID, 200);
      }
      if (allowance.blocked != null && typeof allowance.blocked !== "boolean") throw new HttpError(ID, 200);
      const blocked = allowance.blocked === true;
      const limit = finiteNumber(allowance.limit_usd),
        spent = finiteNumber(allowance.spent_usd);
      if (blocked || (limit !== null && limit > 0 && spent !== null)) {
        windows.push(
          feedWindow(null, blocked ? 100 : (number(spent) / number(limit)) * 100, null, context.now(), "key"),
        );
      }
      if (remaining !== null) windows.push(valueWindow("USD", money(remaining)));
      return finish(context, windows, blocked);
    } catch (error) {
      return signIn(context, error);
    }
  },
};
