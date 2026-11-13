import { accountLabel, feedWindow, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "clawrouter";
const NAME = "ClawRouter";

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
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname);
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

export const clawrouter: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, ID, ["CLAWROUTER_API_KEY"]);
    if (!key) throw new NotConfigured(NAME);
    const entry = await providerEntry(context, ID);
    const now = context.now();
    const base: FeedAccount = {
      provider: ID, provider_name: NAME, account: accountLabel(null),
      blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    try {
      const url = endpoint(text(context.env.CLAWROUTER_BASE_URL) ?? text(entry.enterpriseHost)
        ?? "https://clawrouter.openclaw.ai", "https");
      if (url.search || url.hash) throw new NotConfigured(NAME);
      url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/usage";
      const root = object(await request(context, url, key));
      const budget = object(root.budget);
      const usage = object(root.usage);
      const summary = object(usage.summary);
      if (typeof budget.configured !== "boolean" || typeof budget.ledger !== "string"
        || !Array.isArray(usage.providers)) throw new HttpError(NAME, 200);
      for (const field of ["requestCount", "successCount", "errorCount", "inputTokens", "outputTokens", "totalTokens", "actualCostMicros"]) {
        if (typeof summary[field] !== "number" || !Number.isInteger(summary[field])) throw new HttpError(NAME, 200);
      }
      const micros = (value: unknown): number | null => {
        if (value == null) return null;
        if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new HttpError(NAME, 200);
        return value / 1e6;
      };
      const limit = micros(budget.limitMicros);
      const spent = micros(budget.spentMicros);
      const remaining = micros(budget.remainingMicros);
      const match = text(budget.windowKey)?.match(/(\d{4})-(\d{2})$/);
      const month = match ? Number(match[2]) : 0;
      if (match && (month < 1 || month > 12)) throw new HttpError(NAME, 200);
      const reset = match ? Date.UTC(Number(match[1]), month, 1) / 1000 : null;
      const windows: FeedWindow[] = [];
      if (limit !== null && spent !== null && limit > 0) windows.push(feedWindow(43200, spent / limit * 100, reset, now));
      windows.push(valueWindow("spend", money(spent ?? number(summary.actualCostMicros) / 1e6)));
      return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100)
        || (budget.configured && remaining !== null && remaining <= 0) }];

    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
