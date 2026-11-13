import {
  accountLabel,
  feedWindow,
  isoToSeconds,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "sub2api";
const NAME = "sub2api";

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
  return (
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  );
}

function endpoint(raw: string | null, policy: "private" | "loopback" | "https" = "private"): URL {
  if (!raw) throw new NotConfigured(NAME);
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new NotConfigured(NAME);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname.startsWith("127.");
  const http =
    url.protocol === "http:" && (policy === "private" ? privateHost(url.hostname) : policy === "loopback" && loopback);
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
  try {
    return await response.json();
  } catch {
    throw new HttpError(NAME, response.status);
  }
}

function money(value: number): string {
  const compact =
    Math.abs(value) >= 1e6
      ? `${(value / 1e6).toPrecision(3)}m`
      : Math.abs(value) >= 1e4
        ? `${(value / 1e3).toPrecision(3)}k`
        : value.toFixed(2);
  return `$${compact}`.slice(0, 12);
}

export const sub2api: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, ID, ["SUB2API_API_KEY"]);
    if (!key) throw new NotConfigured(NAME);
    const entry = await providerEntry(context, ID);
    const now = context.now();
    const base: FeedAccount = {
      provider: ID,
      provider_name: NAME,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    try {
      const url = endpoint(text(context.env.SUB2API_BASE_URL) ?? text(entry.enterpriseHost), "loopback");
      if (url.search || url.hash) throw new NotConfigured(NAME);
      let path = url.pathname.replace(/\/+$/, "");
      if (!/\/v1(?:\/usage)?$/.test(path)) path += "/v1";
      if (!path.endsWith("/usage")) path += "/usage";
      url.pathname = path;
      url.searchParams.set("days", "30");
      url.searchParams.set("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      const root = object(await request(context, url, key));
      if (root.isValid === false) throw new SignIn();
      if (root.isValid != null && typeof root.isValid !== "boolean") throw new HttpError(NAME, 200);
      const windows: FeedWindow[] = [];
      let exhausted = false;
      const add = (used: unknown, limit: unknown, minutes: number | null, reset: unknown, name?: string) => {
        const max = number(limit);
        const spent = number(used);
        const date = isoToSeconds(reset);
        if (reset != null && date === null) throw new HttpError(NAME, 200);
        if (max > 0) windows.push(feedWindow(minutes, (spent / max) * 100, date, now, name));
      };
      if (root.subscription != null) {
        const subscription = object(root.subscription);
        for (const [period, minutes] of [
          ["daily", 1440],
          ["weekly", 10080],
          ["monthly", 43200],
        ] satisfies [string, number][]) {
          add(subscription[period + "_usage_usd"], subscription[period + "_limit_usd"], minutes, null);
        }
      } else if (root.quota != null) {
        const quota = object(root.quota);
        for (const field of ["limit", "used", "remaining"]) {
          if (typeof quota[field] !== "number") throw new HttpError(NAME, 200);
        }
        add(quota.used, quota.limit, null, null, "quota");
        exhausted ||= number(quota.remaining) <= 0;
      }
      if (root.rate_limits != null && !Array.isArray(root.rate_limits)) throw new HttpError(NAME, 200);
      const minutesByName: Record<string, number> = { "5h": 300, "1d": 1440, "7d": 10080 };
      for (const raw of Array.isArray(root.rate_limits) ? root.rate_limits : []) {
        const rate = object(raw);
        const name = text(rate.window);
        if (
          !name ||
          typeof rate.limit !== "number" ||
          typeof rate.used !== "number" ||
          typeof rate.remaining !== "number"
        )
          throw new HttpError(NAME, 200);
        exhausted ||= number(rate.remaining) <= 0;
        add(
          rate.used,
          rate.limit,
          Object.hasOwn(minutesByName, name.toLowerCase()) ? minutesByName[name.toLowerCase()] : null,
          rate.reset_at,
          name.slice(0, 6),
        );
      }
      const blocked =
        exhausted || windows.some((w) => (w.used_percent ?? 0) >= 100) || number(root.remaining, Infinity) <= 0;
      windows.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
      if (windows.length < 2 && root.balance != null) {
        const balance = number(root.balance);
        const unit = text(root.unit) ?? (isRecord(root.quota) ? text(root.quota.unit) : null) ?? "USD";
        windows.push(
          valueWindow(
            "balance",
            unit.toUpperCase() === "USD"
              ? money(balance)
              : (new Intl.NumberFormat("en", { notation: "compact" }).format(balance) + " " + unit).slice(0, 12),
          ),
        );
      }
      return [
        {
          ...base,
          windows: windows.slice(0, 2),
          blocked: blocked || (root.balance != null && number(root.balance) <= 0),
        },
      ];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
