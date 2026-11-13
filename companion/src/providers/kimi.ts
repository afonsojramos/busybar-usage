import { randomUUID } from "node:crypto";
import { arch, hostname, release } from "node:os";
import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, windowName, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider, isProviderHost } from "./types.ts";

function parseJSON(text: string | null): unknown {
  try { return text === null ? null : JSON.parse(text); } catch { return null; }
}

async function international(context: Context): Promise<boolean> {
  const configHome = context.env.XDG_CONFIG_HOME || join(context.home, ".config");
  const paths = context.env.CODEXBAR_CONFIG ? [context.env.CODEXBAR_CONFIG] : [
    join(configHome, "codexbar", "config.json"), join(context.home, ".codexbar", "config.json"),
  ];
  for (const path of paths) {
    const config = parseJSON(await context.readFile(path));
    if (config === null) continue;
    const providers = isRecord(config) && Array.isArray(config.providers) ? config.providers : [];
    const entry = providers.find((entry) => isRecord(entry) && entry.id === "kimi");
    return isRecord(entry) && entry.region === "international";
  }
  return false;
}

function endpoint(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new HttpError("Kimi", 0); }
  if (!isProviderHost(url, ["api.kimi.com", "api.kimi.ai"]) || url.username || url.password || url.search || url.hash) {
    throw new HttpError("Kimi", 0);
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path}${path.endsWith("/coding/v1") ? "/usages" : path.endsWith("/coding") ? "/v1/usages" : "/coding/v1/usages"}`;
  return url.toString();
}

const ascii = (value: string) => value.replace(/[^\x20-\x7e]/g, "").trim() || "unknown";

function countWindow(detail: unknown, minutes: number | null, now: number, name: string): FeedWindow | null {
  if (!isRecord(detail)) return null;
  const limit = finiteNumber(detail.limit);
  if (limit === null || !Number.isSafeInteger(limit) || limit <= 0) return null;
  const used = finiteNumber(detail.used);
  const remaining = finiteNumber(detail.remaining);
  const count = used !== null && Number.isSafeInteger(used) && used >= 0 ? used
    : remaining !== null && Number.isSafeInteger(remaining) && remaining >= 0 && remaining <= limit
      ? limit - remaining : null;
  const reset = isoToSeconds(detail.resetTime ?? detail.resetAt ?? detail.reset_time ?? detail.reset_at);
  return feedWindow(count === null ? null : minutes, count === null ? 0 : Math.min(100, count / limit * 100), reset, now, name);
}

function ratioWindow(pool: unknown, minutes: number, now: number): FeedWindow | null {
  if (!isRecord(pool)) return null;
  const ratio = finiteNumber(pool.used_ratio);
  if (ratio === null || ratio < 0) return null;
  return feedWindow(minutes, Math.min(1, ratio) * 100, isoToSeconds(pool.reset_time), now);
}

function reconcile(ratio: FeedWindow | null, count: FeedWindow | null): FeedWindow | null {
  if (!ratio) return count;
  if (count && count.minutes === ratio.minutes && count.resets_at !== null && ratio.resets_at !== null
    && Math.abs(count.resets_at - ratio.resets_at) <= 2
    && (count.used_percent ?? 0) > (ratio.used_percent ?? 0)) return count;
  return ratio;
}

function parseUsage(body: unknown, now: number): { windows: FeedWindow[]; blocked: boolean; email: string | null } | null {
  if (!isRecord(body)) return null;
  const pools = isRecord(body.usages) ? body.usages : {};
  const firstLimit = Array.isArray(body.limits) ? body.limits[0] : null;
  const rate = isRecord(firstLimit) ? firstLimit : null;
  const window = rate && isRecord(rate.window) ? rate.window : null;
  const duration = window ? finiteNumber(window.duration) : null;
  const unit = window?.timeUnit;
  const multiplier = unit === "TIME_UNIT_MINUTE" ? 1 : unit === "TIME_UNIT_HOUR" ? 60 : unit === "TIME_UNIT_DAY" ? 1440 : null;
  const minutes = window === null ? 300 : duration !== null && duration > 0 && multiplier !== null
    && Number.isSafeInteger(duration * multiplier) ? duration * multiplier : null;
  const session = reconcile(ratioWindow(pools.limit_5h, 300, now), countWindow(rate?.detail, minutes, now, minutes === null ? "rate" : windowName(minutes)));
  const weekly = reconcile(ratioWindow(pools.limit_7d, 10080, now), countWindow(body.usage, 10080, now, "7d"));
  const monthly = ratioWindow(pools.limit_month_total, 43200, now);
  const all = [session, weekly, monthly].filter((item): item is FeedWindow => item !== null)
    .sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  if (all.length === 0) return null;
  const user = isRecord(body.user) ? body.user : null;
  return { windows: all.slice(0, 2), blocked: all.some((w) => (w.used_percent ?? 0) >= 100),
    email: typeof user?.email === "string" ? user.email : null };
}

export const kimi: Provider = {
  id: "kimi",
  name: "Kimi",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const isInternational = await international(context);
    const key = await apiKey(context, "kimi", ["KIMI_CODE_API_KEY"]);
    let token = key;
    let stale = false;
    const headers: Record<string, string> = { Accept: "application/json" };
    const override = context.env.KIMI_CODE_BASE_URL?.trim();
    if (!token && !isInternational && !override
      && !context.env.KIMI_CODE_OAUTH_HOST?.trim() && !context.env.KIMI_OAUTH_HOST?.trim()) {
      const home = context.env.KIMI_CODE_HOME || join(context.home, ".kimi-code");
      const credential = parseJSON(await context.readFile(join(home, "credentials", "kimi-code.json")));
      if (isRecord(credential)) {
        token = typeof credential.access_token === "string" ? credential.access_token.trim() || null : null;
        const expires = finiteNumber(credential.expires_at);
        stale = token !== null && (expires === null || expires <= now + 60);
        if (!token && typeof credential.refresh_token === "string" && credential.refresh_token.trim()) stale = true;
      }
      if (token && !stale) {
        const os = context.platform === "darwin" ? "macOS" : context.platform === "linux" ? "Linux" : "unknown";
        // A missing device ID stays in memory; the companion never writes CLI-owned files.
        const device = (await context.readFile(join(home, "device_id")))?.trim() || randomUUID();
        Object.assign(headers, { "User-Agent": "busybar-usage/development", "X-Msh-Platform": "kimi_code_cli",
          "X-Msh-Version": "development", "X-Msh-Device-Name": ascii(hostname()),
          "X-Msh-Device-Model": ascii(`${os} ${release()} ${arch()}`), "X-Msh-Os-Version": ascii(release()),
          "X-Msh-Device-Id": ascii(device) });
      }
    }
    const base: FeedAccount = { provider: "kimi", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [] };
    // Kimi refresh tokens rotate; only the official CLI may renew and persist them.
    if (stale) return [{ ...base, error: "sign in" }];
    if (!token) throw new NotConfigured("Kimi");
    headers.Authorization = `Bearer ${token}`;
    const response = await context.fetch(endpoint(override || `https://api.kimi.${isInternational ? "ai" : "com"}/coding/v1`), {
      headers, signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Kimi", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Kimi", response.status);
    let body: unknown;
    try { body = await response.json(); } catch { throw new HttpError("Kimi", response.status); }
    const usage = parseUsage(body, now);
    if (!usage) throw new HttpError("Kimi", response.status);
    return [{ ...base, windows: usage.windows, blocked: usage.blocked, account: accountLabel(usage.email) }];
  },
};
