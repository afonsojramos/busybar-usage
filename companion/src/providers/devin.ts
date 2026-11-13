import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { join } from "node:path";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const NAME = "Devin";
const APP_QUERY = "SELECT key, value FROM ItemTable WHERE key LIKE 'secret://%' OR key LIKE 'devin.desktopShell.%';";

function date(value: unknown): number | null {
  const n = finiteNumber(value);
  return n === null ? isoToSeconds(value) : n > 0 ? n > 10_000_000_000 ? n / 1000 : n : null;
}

function first(object: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber(object[key]);
    if (value !== null) return value;
  }
  return null;
}

function percent(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n !== null) return n <= 1 ? n * 100 : n;
  if (!isRecord(value)) return null;
  const direct = first(value, ["used_percent", "usedPercent", "usage_percent", "usagePercent", "percent_used", "percentUsed", "percent"]);
  if (direct !== null) return direct <= 1 ? direct * 100 : direct;
  const remaining = first(value, ["remaining_percent", "remainingPercent", "percent_remaining", "percentRemaining"]);
  if (remaining !== null) return 100 - (remaining <= 1 ? remaining * 100 : remaining);
  const limit = first(value, ["limit", "quota", "total", "max", "available"]);
  const used = first(value, ["used", "usage", "used_count", "usedCount", "consumed"]);
  const left = first(value, ["remaining", "left", "available"]);
  return limit !== null && limit > 0 ? used !== null ? used / limit * 100 : left !== null ? (limit - left) / limit * 100 : null : null;
}

function fallbackWindow(value: unknown, period: "day" | "week", minutes: number, now: number, depth = 0): FeedWindow | null {
  if (depth > 20 || (!isRecord(value) && !Array.isArray(value))) return null;
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (!(key.toLowerCase().includes(period) || period === "day" && key.toLowerCase().includes("daily")) || key.toLowerCase().includes("hide")) continue;
      const found = windowFrom(child, minutes, now, depth + 1);
      if (found) return found;
    }
  }
  for (const child of Object.values(value)) {
    const found = fallbackWindow(child, period, minutes, now, depth + 1);
    if (found) return found;
  }
  return null;
}

function windowFrom(value: unknown, minutes: number, now: number, depth: number): FeedWindow | null {
  if (depth > 20) return null;
  const used = percent(value);
  if (used !== null) {
    const reset = isRecord(value) ? Object.entries(value).find(([key]) => key.toLowerCase().includes("reset"))?.[1] : null;
    return feedWindow(minutes, Math.min(100, Math.max(0, used)), date(reset), now);
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) {
      const found = windowFrom(child, minutes, now, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

export function parseUsage(json: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(json)) return null;
  const windows: FeedWindow[] = [];
  for (const [period, minutes, key] of [["day", 1440, "daily"], ["week", 10080, "weekly"]] as const) {
    if (key === "daily" && json.hide_daily_quota === true) continue;
    const used = finiteNumber(json[`${key}_percentage`]);
    const window = used === null ? fallbackWindow(json, period, minutes, now)
      : feedWindow(minutes, Math.min(100, Math.max(0, used < 1 ? used * 100 : used)), date(json[`${key}_reset_at`]), now);
    if (window) windows.push(window);
  }
  if (windows.length === 0) return null;
  const balance = finiteNumber(json.overage_balance) ?? ((finiteNumber(json.overage_balance_cents) ?? -100) / 100);
  if (windows.length < 2 && balance >= 0) windows.push(valueWindow("extra", `$${balance.toFixed(2)}`.slice(0, 12)));
  return windows;
}

function decoded(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array)) return null;
  const bytes = Buffer.from(value);
  return bytes.length % 2 === 0 && bytes.some((v, i) => i % 2 === 1 && v === 0)
    ? bytes.toString("utf16le") : bytes.toString("utf8");
}

async function desktopAuth(context: Context): Promise<{ token: string; organization: string | null } | null> {
  if (context.platform !== "darwin") return null;
  const rows = await context.querySqlite(join(context.home, "Library/Application Support/Devin/User/globalStorage/state.vscdb"), APP_QUERY);
  if (!rows) return null;
  const blobs: Buffer[] = [];
  const ids = new Set<string>();
  for (const row of rows) {
    const key = decoded(row.key);
    if (!key) continue;
    if (key.startsWith("devin.desktopShell.")) {
      const id = /org[-_][A-Za-z0-9]{8,}/.exec(key)?.[0];
      if (id) ids.add(id);
    }
    if (!key.startsWith("secret://")) continue;
    try {
      const metadata: unknown = JSON.parse(key.slice(9));
      if (!isRecord(metadata) || metadata.key !== "windsurf_auth.sessions") continue;
      const stored: unknown = JSON.parse(decoded(row.value) ?? "null");
      if (!isRecord(stored) || stored.type !== "Buffer" || !Array.isArray(stored.data)
        || !stored.data.every((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255)) continue;
      const bytes = Buffer.from(stored.data);
      if (bytes.length > 3 && (bytes.length - 3) % 16 === 0 && bytes.subarray(0, 3).toString() === "v10") blobs.push(bytes);
    } catch { continue; }
  }
  if (blobs.length === 0) return null;
  const password = await context.readKeychain("Devin Safe Storage", "Devin Key");
  if (!password) return null;
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  for (const blob of blobs) {
    try {
      const cipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
      const sessions: unknown = JSON.parse(Buffer.concat([cipher.update(blob.subarray(3)), cipher.final()]).toString("utf8"));
      if (!Array.isArray(sessions)) continue;
      for (const session of sessions) {
        if (isRecord(session) && typeof session.accessToken === "string" && session.accessToken.trim()) {
          return { token: session.accessToken.trim(), organization: ids.size === 1 ? [...ids][0] ?? null : null };
        }
      }
    } catch { continue; }
  }
  return null;
}

function organization(raw: string): { path: string; id: string | null } | null {
  let value = raw.trim();
  if (value.startsWith("https://")) {
    try {
      const url = new URL(value);
      if (url.hostname !== "devin.ai" && !url.hostname.endsWith(".devin.ai")) return null;
      value = url.pathname;
    } catch { return null; }
  }
  value = value.replace(/^\/+|\/+$/g, "");
  const match = /^(?:(org|organizations)\/)?([A-Za-z0-9_-]+)(?:\/.*)?$/.exec(value);
  if (!match?.[2]) return null;
  const name = match[2];
  const internal = /^org[-_]/.test(name);
  return { path: `${internal ? "organizations" : match[1] ?? "org"}/${name}`, id: internal ? name : null };
}

export const devin: Provider = {
  id: "devin", name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, "devin");
    if (entry.cookieSource === "off") throw new NotConfigured(NAME);
    let raw = await cookieHeader(context, "devin", { domains: [], envNames: ["DEVIN_BEARER_TOKEN", "DEVIN_AUTHORIZATION"] });
    if (context.env.DEVIN_BEARER_TOKEN !== undefined && !context.env.DEVIN_BEARER_TOKEN.trim()
      || context.env.DEVIN_AUTHORIZATION !== undefined && context.env.DEVIN_BEARER_TOKEN === undefined && !context.env.DEVIN_AUTHORIZATION.trim()) raw = null;
    const hasEnvironmentOverride = context.env.DEVIN_BEARER_TOKEN !== undefined || context.env.DEVIN_AUTHORIZATION !== undefined;
    const desktop = !raw && !hasEnvironmentOverride && entry.cookieSource !== "manual" ? await desktopAuth(context) : null;
    const token = raw?.replace(/^Authorization:\s*/i, "").replace(/^Bearer\s+/i, "").trim() ?? desktop?.token;
    if (!token) throw new NotConfigured(NAME);
    const configured = context.env.DEVIN_ORGANIZATION ?? context.env.DEVIN_ORG ?? entry.workspaceID ?? desktop?.organization;
    const org = typeof configured === "string" ? organization(configured) : null;
    if (!org) throw new NotConfigured(NAME);
    const now = context.now();
    const base: FeedAccount = { provider: "devin", account: accountLabel(null), observed_at: new Date(now * 1000).toISOString(), blocked: false, windows: [] };
    const paths = [...new Set([...(org.id ? [`${org.id}/billing/quota/usage`] : []), `${org.path}/billing/quota/usage`, ...(org.path.startsWith("org/") ? [`${org.path.slice(4)}/billing/quota/usage`] : [])])];
    let lastStatus = 404;
    for (const path of paths) {
      const response = await context.fetch(`https://app.devin.ai/api/${path}`, {
        headers: { Accept: "application/json", "Accept-Language": "en-US,en;q=0.9", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36", Authorization: `Bearer ${token}`, ...(org.id ? { "x-cog-org-id": org.id } : {}) },
        signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
      if (response.status === 429) throw new RateLimited(NAME, now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) { lastStatus = response.status; continue; }
      let data: unknown;
      try { data = await response.json(); } catch { throw new HttpError(NAME, response.status); }
      const windows = parseUsage(data, now);
      if (!windows) throw new HttpError(NAME, response.status);
      return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
    }
    throw new HttpError(NAME, lastStatus);
  },
};
