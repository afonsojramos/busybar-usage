import { accountLabel, feedWindow, isoToSeconds, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "llmproxy";
const NAME = "LLM Proxy";

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

export const llmproxy: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, ID, ["LLM_PROXY_API_KEY"]);
    if (!key) throw new NotConfigured(NAME);
    const entry = await providerEntry(context, ID);
    const now = context.now();
    const base: FeedAccount = {
      provider: ID, provider_name: NAME, account: accountLabel(null),
      blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    try {
      const url = endpoint(text(context.env.LLM_PROXY_BASE_URL) ?? text(entry.enterpriseHost));
      url.pathname = url.pathname.replace(/\/+$/, "");
      if (!decodeURIComponent(url.pathname).endsWith("/v1")) url.pathname += "/v1";
      url.pathname += "/quota-stats";
      const root = object(await request(context, url, key));
      const providers = object(root.providers);
      const groups: { remaining: number | null; reset: number | null }[] = [];
      let totalCost = 0;
      let totalRequests = 0;
      for (const raw of Object.values(providers)) {
        const provider = object(raw);
        for (const field of ["credential_count", "active_count", "exhausted_count", "total_requests"]) {
          if (!Number.isInteger(number(provider[field]))) throw new HttpError(NAME, 200);
        }
        totalCost += number(provider.approx_cost);
        totalRequests += number(provider.total_requests);
        // Optional malformed quota groups must not discard the other usage.
        try {
          const values = provider.quota_groups == null ? [] : Array.isArray(provider.quota_groups)
            ? provider.quota_groups : Object.values(object(provider.quota_groups));
          const parsed = values.map((raw) => {
            const group = object(raw);
            const remaining = group.remaining_percent == null ? null : number(group.remaining_percent);
            const reset = isoToSeconds(text(group.reset_time));
            return { remaining, reset: reset !== null && reset > now ? reset : null };
          });
          groups.push(...parsed);
        } catch (error) {
          if (!(error instanceof HttpError)) throw error;
        }
      }
      const summary = root.summary == null ? {} : object(root.summary);
      const cost = number(summary.approx_cost, totalCost);
      const requests = number(summary.total_requests, totalRequests);
      if (!Number.isFinite(cost) || !Number.isFinite(requests)) throw new HttpError(NAME, 200);
      const hasCost = summary.approx_cost != null || totalCost > 0;
      const resets = groups.flatMap((group) => group.reset === null ? [] : [group.reset]);
      const windows: FeedWindow[] = [];
      const remaining = groups.flatMap((group) => group.remaining === null ? [] : [group.remaining]);
      if (remaining.length) windows.push(feedWindow(null,
        Math.max(0, Math.min(100, 100 - Math.min(...remaining))),
        resets.length ? Math.min(...resets) : null, now, "quota"));
      if (hasCost) windows.push(valueWindow("spend", money(cost)));
      else windows.push(valueWindow("reqs", new Intl.NumberFormat("en", { notation: "compact" }).format(requests).slice(0, 12)));
      return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];

    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
