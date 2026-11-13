import { accountLabel, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "wayfinder";
const NAME = "Wayfinder";

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

export const wayfinder: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    
    const entry = await providerEntry(context, ID);
    const now = context.now();
    const base: FeedAccount = {
      provider: ID, provider_name: NAME, account: accountLabel(null),
      blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    try {
      const configured = text(context.env.WAYFINDER_GATEWAY_URL) ?? text(entry.enterpriseHost);
      const url = endpoint(configured ?? "http://127.0.0.1:8088", "loopback");
      const path = url.pathname.replace(/\/+$/, "");
      url.search = "";
      url.hash = "";
      url.pathname = path + "/healthz";
      const health = object(await request(context, url, null).catch((error: unknown) => {
        // Nothing listening at the default address, with none configured, means Wayfinder is not running here.
        if (!configured && error instanceof TypeError) throw new NotConfigured(NAME);
        throw error;
      }));
      if (typeof health.status !== "string" || typeof health.offline !== "boolean") throw new HttpError(NAME, 200);
      url.pathname = path + "/router/models";
      const models = object(await request(context, url, null));
      if (!Array.isArray(models.models) || typeof models.dry_run !== "boolean"
        || models.models.some((raw) => typeof object(raw).name !== "string")) throw new HttpError(NAME, 200);
      url.pathname = path + "/v1/savings";
      url.searchParams.set("period", "30d");
      const savings = object(await request(context, url, null));
      if (typeof savings.priced !== "boolean") throw new HttpError(NAME, 200);
      for (const field of ["requests", "tokens", "realized", "baseline", "saved", "saved_pct"]) {
        if (typeof savings[field] !== "number") throw new HttpError(NAME, 200);
        number(savings[field]);
      }
      object(savings.by_route);
      // Latency metrics are best effort and do not displace savings or requests on the bar.
      try {
        url.pathname = path + "/metrics";
        url.search = "";
        const response = await context.fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
        if (response.status === 401 || response.status === 403) throw new SignIn();
        if (response.status === 429) throw new RateLimited(NAME, now + retryAfterSeconds(response.headers, 300));
        await response.text();
      } catch (error) {
        if (error instanceof RateLimited || error instanceof SignIn) throw error;
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
      }
      const saved = number(savings.saved);
      const value = savings.priced ? (saved > 0 && saved < .01 ? "<$0.01" : money(saved)) : number(savings.saved_pct).toFixed(1).slice(0, 10) + "%";
      return [{ ...base, windows: [valueWindow("saved", value),
        valueWindow("reqs", new Intl.NumberFormat("en", { notation: "compact" }).format(number(savings.requests)).slice(0, 12))] }];

    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
