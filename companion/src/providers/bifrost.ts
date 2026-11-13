import { accountLabel, feedWindow, isoToSeconds, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "bifrost";
const NAME = "Bifrost";

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
  if (key) headers["x-bf-vk"] = key;
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

export const bifrost: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, ID, ["BIFROST_API_KEY"]);
    if (!key) throw new NotConfigured(NAME);
    const entry = await providerEntry(context, ID);
    const now = context.now();
    const base: FeedAccount = {
      provider: ID, provider_name: NAME, account: accountLabel(null),
      blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    try {
      const url = endpoint(text(context.env.BIFROST_BASE_URL) ?? text(entry.enterpriseHost));
      url.pathname = url.pathname.replace(/\/+$/, "") + "/api/governance/virtual-keys/quota";
      const root = object(await request(context, url, key));
      if (root.is_active != null && typeof root.is_active !== "boolean") throw new HttpError(NAME, 200);
      const array = (value: unknown): Record<string, unknown>[] => {
        if (value == null) return [];
        if (!Array.isArray(value)) throw new HttpError(NAME, 200);
        return value.map(object);
      };
      const duration = (value: unknown): number | null => {
        const raw = text(value);
        if (!raw) return null;
        const units: Record<string, number> = { Y: 31536000, Q: 7776000, M: 2592000, w: 604800,
          d: 86400, h: 3600, m: 60, s: 1, ms: .001, us: .000001, "µs": .000001, "μs": .000001, ns: 1e-9 };
        const extended = raw.match(/^(\d+(?:\.\d+)?)([dwMQY])$/);
        if (extended) return Number(extended[1]) * units[extended[2]];
        const parts = [...raw.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/g)];
        if (parts.map((part) => part[0]).join("") !== raw) return null;
        const seconds = parts.reduce((sum, part) => sum + Number(part[1]) * units[part[2]], 0);
        return seconds > 0 && Number.isFinite(seconds) ? seconds : null;
      };
      const timing = (raw: unknown, lastReset: unknown) => {
        const seconds = duration(raw);
        const calendar = /[dwMQY]$/.test(text(raw) ?? "");
        const last = isoToSeconds(lastReset);
        // Calendar alignment is absent from this endpoint, so do not invent reset dates.
        const reset = !calendar && seconds !== null && last !== null
          ? last + (Math.max(0, Math.floor((now - last) / seconds)) + 1) * seconds : null;
        const minutes = !calendar && seconds !== null && seconds >= 60 ? Math.floor(seconds / 60) : null;
        const name = text(raw)?.slice(0, 6) ?? "quota";
        return { seconds, reset, minutes, name };
      };
      const lanes: { window: FeedWindow; seconds: number; scope: number; budget: boolean }[] = [];
      let spend: number | null = null;
      let spendPeriod = Infinity;
      const scopes = [root, ...array(root.provider_configs), ...array(root.model_configs)];
      let blocked = root.is_active === false;
      for (const [scopeIndex, scope] of scopes.entries()) {
        for (const budget of array(scope.budgets)) {
          if (!text(budget.id)) continue;
          const override = number(budget.override_amount);
          const cycles = number(budget.override_cycles_remaining);
          if (!Number.isInteger(cycles)) throw new HttpError(NAME, 200);
          const active = override > 0 && (budget.override_mode === "forever" || (budget.override_mode === "cycles" && cycles > 0));
          const limit = number(budget.max_limit) + (active ? override : 0);
          if (!Number.isFinite(limit)) throw new HttpError(NAME, 200);
          const used = number(budget.current_usage);
          const time = timing(budget.reset_duration, budget.last_reset);
          if (scopeIndex === 0 && (spend === null || (time.seconds ?? Infinity) < spendPeriod)) {
            spend = used;
            spendPeriod = time.seconds ?? Infinity;
          }
          if (limit > 0) {
            const window = feedWindow(time.minutes, used / limit * 100, time.reset, now, time.minutes === null ? time.name : undefined);
            blocked ||= (window.used_percent ?? 0) >= 100;
            lanes.push({ window, seconds: time.seconds ?? Infinity, scope: scopeIndex, budget: true });
          }
        }
        const components = array(scope.rate_limits);
        const limits = components.length ? components : scope.rate_limit == null ? [] : [object(scope.rate_limit)];
        for (const limit of limits) {
          for (const dimension of ["token", "request"]) {
            const max = number(limit[dimension + "_max_limit"]);
            if (max <= 0) continue;
            const used = number(limit[dimension + "_current_usage"]);
            const time = timing(limit[dimension + "_reset_duration"], limit[dimension + "_last_reset"]);
            const window = feedWindow(time.minutes, used / max * 100, time.reset, now, time.minutes === null ? dimension.slice(0, 4) : undefined);
            blocked ||= (window.used_percent ?? 0) >= 100;
            lanes.push({ window, seconds: time.seconds ?? Infinity, scope: scopeIndex, budget: false });
          }
        }
      }
      lanes.sort((a, b) => a.scope - b.scope || Number(b.budget) - Number(a.budget) || a.seconds - b.seconds);
      const windows = lanes.slice(0, 2).map((lane) => lane.window);
      windows.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
      if (windows.length < 2 && spend !== null) windows.push(valueWindow("spend", money(spend)));
      return [{ ...base, windows, blocked }];

    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
