import { join } from "node:path";
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

const ID = "nous";
const NAME = "Nous";
function fail(): never {
  throw new HttpError(NAME, 200);
}
function object(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : fail();
}
function number(value: unknown): number {
  return finiteNumber(value) ?? fail();
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
  let key = (await apiKey(context, ID, ["NOUS_PORTAL_ACCESS_TOKEN"]))?.replace(/^(["'])(.*)\1$/, "$2").trim() || null;
  let stored: Record<string, unknown> = {},
    expired = false;
  const expiry = (state: Record<string, unknown>, token: string) => {
    const explicit = isoToSeconds(state.expires_at);
    if (explicit !== null) return explicit;
    try {
      const payload: unknown = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
      return isRecord(payload) ? finiteNumber(payload.exp) : null;
    } catch {
      return null;
    }
  };
  if (!key) {
    const root = (context.env.HERMES_HOME || join(context.home, ".hermes")).replace(/^~(?=\/|$)/, context.home);
    for (const path of [join(root, "auth.json"), join(root, "shared/nous_auth.json")]) {
      const text = await context.readFile(path);
      if (text === null) continue;
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isRecord(data)) continue;
      const direct = isRecord(data.providers) && isRecord(data.providers.nous) ? data.providers.nous : null;
      const pool =
        isRecord(data.credential_pool) && Array.isArray(data.credential_pool.nous) ? data.credential_pool.nous : [];
      const candidates = pool
        .filter(isRecord)
        .filter((s) => typeof s.access_token === "string" && s.access_token.trim());
      candidates.sort(
        (a, b) =>
          (isoToSeconds(b.agent_key_expires_at) ?? 0) - (isoToSeconds(a.agent_key_expires_at) ?? 0) ||
          (expiry(b, String(b.access_token)) ?? 0) - (expiry(a, String(a.access_token)) ?? 0) ||
          number(a.priority ?? 0) - number(b.priority ?? 0),
      );
      const state =
        direct && typeof direct.access_token === "string" && direct.access_token.trim()
          ? direct
          : (candidates[0] ?? data);
      if (typeof state.access_token !== "string" || !state.access_token.trim()) continue;
      const token = state.access_token
          .trim()
          .replace(/^(["'])(.*)\1$/, "$2")
          .trim(),
        end = expiry(state, token);
      if (!token) continue;
      if (end !== null && end <= context.now() + 60) {
        expired = true;
        continue;
      }
      key = token;
      stored = state;
      break;
    }
  }
  if (!key) {
    if (expired) return account(context, []).map((a) => ({ ...a, error: "sign in" }));
    throw new NotConfigured(NAME);
  }
  // Hermes refresh tokens rotate; only read the access token, never refresh or rewrite it.
  const end = expiry(stored, key);
  if (end !== null && end <= context.now() + 60) return account(context, []).map((a) => ({ ...a, error: "sign in" }));
  const origin = (value: unknown): URL | null => {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
        ? url
        : null;
    } catch {
      return null;
    }
  };
  const trusted = origin(stored.portal_base_url);
  const portal =
    origin(context.env.NOUS_PORTAL_BASE_URL) ??
    origin(context.env.HERMES_PORTAL_BASE_URL) ??
    (trusted && (trusted.hostname === "nousresearch.com" || trusted.hostname.endsWith(".nousresearch.com"))
      ? trusted
      : new URL("https://portal.nousresearch.com"));
  const data = await read(context, `${portal.origin}/api/oauth/account`, key);
  if (data.error) return fail();
  const sub = data.subscription == null ? {} : object(data.subscription);
  const access = data.paid_service_access == null ? {} : object(data.paid_service_access);
  const optional = (value: unknown) => {
    if (value == null) return null;
    if (typeof value === "string" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))
      return fail();
    return number(value);
  };
  const monthly = optional(sub.monthly_credits),
    remaining = optional(sub.credits_remaining) ?? optional(access.subscription_credits_remaining);
  const rollover = optional(sub.rollover_credits);
  const purchased = optional(data.purchased_credits_remaining) ?? optional(access.purchased_credits_remaining);
  const total = optional(access.total_usable_credits);
  if ((monthly !== null && monthly < 0) || [monthly, remaining, rollover, purchased, total].every((v) => v === null))
    return fail();
  const reset = isoToSeconds(sub.current_period_end);
  if (sub.current_period_end != null && reset === null) return fail();
  const windows: FeedWindow[] = [];
  if (monthly !== null && monthly > 0 && remaining !== null)
    windows.push(
      feedWindow(43200, (Math.max(0, monthly - Math.max(0, remaining)) / monthly) * 100, reset, context.now()),
    );
  const balance = total ?? purchased;
  if (balance !== null) windows.push(valueWindow(total !== null ? "usable" : "top-up", usd(balance)));
  return account(context, windows, isRecord(data.user) ? data.user.email : null);
}
export const nous: Provider = {
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
