import { accountLabel, feedWindow, isoToSeconds, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "aixy";
const NAME = "Aixy";

class SignIn extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(NAME, 200);
  return value;
}

function number(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(NAME, 200);
  return value;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new HttpError(NAME, 200);
  return value.trim() || null;
}

function privateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "[::1]" || /^\[f[cd][0-9a-f]{2}:/i.test(host) || /^\[fe[89ab][0-9a-f]:/i.test(host)) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function endpoint(raw: string | null, policy: "private" | "loopback" | "https" = "private"): URL {
  if (!raw) throw new NotConfigured(NAME);
  let url: URL;
  try { url = new URL(raw.includes("://") ? raw : `https://${raw}`); }
  catch { throw new NotConfigured(NAME); }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname.startsWith('127.');
  const http = url.protocol === "http:" && (policy === "private" ? privateHost(url.hostname)
    : policy === "loopback" && loopback);
  if ((url.protocol !== "https:" && !http) || url.username || url.password) throw new NotConfigured(NAME);
  return url;
}

async function request(context: Context, url: URL, key: string | null): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const response = await context.fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (response.status === 401 || response.status === 403) throw new SignIn();
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try { return await response.json(); }
  catch { throw new HttpError(NAME, response.status); }
}

function money(value: number): string {
  const compact = Math.abs(value) >= 1e6 ? `${(value / 1e6).toPrecision(3)}m`
    : Math.abs(value) >= 1e4 ? `${(value / 1e3).toPrecision(3)}k` : value.toFixed(2);
  return `$${compact}`.slice(0, 12);
}

export const aixy: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, ID, ["AIXY_API_KEY"]);
    if (!key) throw new NotConfigured(NAME);
    const entry = await providerEntry(context, ID);
    const now = context.now();
    const base: FeedAccount = {
      provider: ID, provider_name: NAME, account: accountLabel(null),
      blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    try {
      const url = endpoint(text(context.env.AIXY_BASE_URL) ?? text(entry.enterpriseHost) ?? "https://api.aixy-gateway.com");
      if (url.search || url.hash) throw new NotConfigured(NAME);
      url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/usage";
      const root = object(await request(context, url, key));
      if (root.object !== "key.usage" || root.currency !== "USD" || isoToSeconds(root.as_of) === null
        || !Array.isArray(root.budgets) || root.budgets.length > 64) throw new HttpError(NAME, 200);
      const identity = object(root.key);
      if (!text(identity.id)) throw new HttpError(NAME, 200);
      const amount = (value: unknown): number | null => {
        if (value == null) return null;
        const parsed = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
        if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) throw new HttpError(NAME, 200);
        return parsed;
      };
      const date = (value: unknown): number | null => {
        if (value == null) return null;
        const result = isoToSeconds(value);
        if (result === null) throw new HttpError(NAME, 200);
        return result;
      };
      const ids = new Set<string>();
      const budgets = root.budgets.map((raw) => {
        const budget = object(raw);
        const id = text(budget.id);
        const interval = text(budget.interval);
        if (!id || ids.has(id) || !["daily", "weekly", "monthly", "lifetime"].includes(interval ?? "")
          || !["organization", "project", "team", "user", "api_key"].includes(text(budget.scope) ?? "")
          || !["hard", "monitor"].includes(text(budget.enforcement) ?? "")
          || typeof budget.shared !== "boolean") throw new HttpError(NAME, 200);
        ids.add(id);
        if (!Array.isArray(budget.applies_to) || !budget.applies_to.length
          || budget.applies_to.some((raw) => {
            const applies = object(raw);
            return applies.api_key_id !== identity.id || applies.project_id !== identity.project_id;
          })) throw new HttpError(NAME, 200);
        const limit = amount(budget.limit_usd);
        if (limit === null || limit <= 0) throw new HttpError(NAME, 200);
        const availability = object(budget.availability);
        if (!["available", "unavailable", "not_enforced"].includes(text(availability.status) ?? "")
          || !["available", "unavailable"].includes(text(budget.spend_status) ?? "")) throw new HttpError(NAME, 200);
        const hard = budget.enforcement === "hard";
        const known = (hard ? availability.status : budget.spend_status) === "available";
        const spent = amount(hard ? availability.spent_usd : budget.spend_usd);
        const reserved = hard ? amount(availability.reserved_usd) : 0;
        const remaining = amount(hard ? availability.remaining_usd : budget.remaining_usd);
        if (known && (spent === null || reserved === null || remaining === null)) throw new HttpError(NAME, 200);
        const used = known ? (spent ?? 0) + (reserved ?? 0) : null;
        if (used !== null && !Number.isFinite(used)) throw new HttpError(NAME, 200);
        const start = date(budget.starts_at);
        const reset = date(budget.resets_at);
        if (start !== null && reset !== null && reset <= start) throw new HttpError(NAME, 200);
        const period: Record<string, number> = { daily: 1440, weekly: 10080, monthly: 43200 };
        const minutes = start !== null && reset !== null ? (reset - start) / 60 : period[interval ?? ""] ?? null;
        return { id, hard, known, remaining, window: used === null ? null
          : feedWindow(minutes, used / limit * 100, reset, now, minutes === null ? "life" : undefined) };
      });
      const known = budgets.filter((budget) => budget.window !== null);
      known.sort((a, b) => Number(b.hard) - Number(a.hard)
        || (b.window?.used_percent ?? 0) - (a.window?.used_percent ?? 0) || a.id.localeCompare(b.id));
      const windows = known.slice(0, 2).flatMap((budget) => budget.window ? [budget.window] : []);
      windows.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
      if (root.usage != null) {
        const usage = object(root.usage);
        if (usage.window !== "7d") throw new HttpError(NAME, 200);
        for (const field of ["requests", "total_tokens", "attributed_requests", "partial_requests"]) {
          if (typeof usage[field] !== "number" || !Number.isSafeInteger(usage[field]) || number(usage[field]) < 0) {
            throw new HttpError(NAME, 200);
          }
        }
        const requests = number(usage.requests);
        const attributed = number(usage.attributed_requests);
        const spend = amount(usage.spend_usd);
        if (attributed > requests || number(usage.partial_requests) > attributed
          || (spend !== null && spend > 0 && attributed === 0)) throw new HttpError(NAME, 200);
        if (windows.length < 2 && spend !== null) windows.push(valueWindow("spend", money(spend)));
      }
      return [{ ...base, windows, blocked: budgets.some((budget) => (budget.window?.used_percent ?? 0) >= 100
        || (budget.hard && budget.known && budget.remaining === 0)) }];

    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
