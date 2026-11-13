import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const usedKeys = ["percentUsed", "usedPercent", "usagePercent", "usage_percent", "used_percent", "percent_used", "percent"];
const remainingKeys = ["percentRemaining", "remainingPercent", "remaining_percent", "percent_remaining"];
const limitKeys = ["limit", "messageLimit", "message_limit", "messages", "maxRequests", "max_requests", "requestLimit", "request_limit", "quota", "max", "total", "capacity", "allowance"];
const countKeys = ["used", "usage", "usedMessages", "used_messages", "messagesUsed", "messages_used", "requests", "requestCount", "request_count", "consumed", "spent"];
const balanceKeys = ["remaining", "left", "available", "balance"];
const labelKeys = ["name", "label", "type", "period", "scope", "title", "id"];
// Partial regeneration dates do not reset the full quota represented by a feed window.
const resetKeys = ["resetAt", "reset_at", "resetsAt", "resets_at", "renewAt", "renew_at", "renewsAt", "renews_at", "periodEnd", "period_end", "expiresAt", "expires_at", "endAt", "end_at"];

function firstNumber(payload: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const number = finiteNumber(payload[key]);
    if (number !== null) return number;
  }
  return null;
}

function firstString(payload: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function duration(payload: Record<string, unknown>): number | null {
  for (const [keys, multiplier] of [
    [["windowMinutes", "window_minutes", "periodMinutes", "period_minutes"], 1],
    [["windowHours", "window_hours", "periodHours", "period_hours"], 60],
    [["windowDays", "window_days", "periodDays", "period_days"], 1440],
    [["windowSeconds", "window_seconds", "periodSeconds", "period_seconds"], 1 / 60],
  ] satisfies [string[], number][]) {
    const number = firstNumber(payload, keys);
    if (number !== null && number > 0) return Math.max(1, Math.round(number * multiplier));
  }
  const text = firstString(payload, ["window", "windowLabel", "window_label", "period", "periodLabel", "period_label"]);
  const match = text?.toLowerCase().replace(/\s/g, "").match(/^([0-9]*\.?[0-9]+)(minutes?|mins?|m|hours?|hrs?|hr|h|days?|d)$/);
  if (match) {
    const count = Number(match[1]);
    if (count > 0) return Math.max(1, Math.round(count * (match[2].startsWith("d") ? 1440 : match[2].startsWith("h") ? 60 : 1)));
  }
  const label = firstString(payload, labelKeys)?.toLowerCase();
  if (label === "monthly") return 43200;
  if (label === "weekly") return 10080;
  if (label === "daily") return 1440;
  if (label === "hourly") return 60;
  return null;
}

function quota(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && [usedKeys, remainingKeys, limitKeys, countKeys, balanceKeys].some((keys) => firstNumber(value, keys) !== null);
}

function collect(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 16) return [];
  if (quota(value)) return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collect(item, depth + 1));
  return isRecord(value) ? Object.keys(value).sort().flatMap((key) => collect(value[key], depth + 1)) : [];
}

function parseQuota(payload: Record<string, unknown>, now: number, minutes: number | null, points = false): FeedWindow | null {
  const normalize = (value: number | null): number | null => value === null ? null : !points && value <= 1 ? value * 100 : value;
  let percent = normalize(firstNumber(payload, usedKeys));
  const remainingPercent = normalize(firstNumber(payload, remainingKeys));
  if (percent === null && remainingPercent !== null) percent = 100 - remainingPercent;
  if (percent === null) {
    let limit = firstNumber(payload, limitKeys);
    let used = firstNumber(payload, countKeys);
    const remaining = firstNumber(payload, balanceKeys);
    if (limit === null && used !== null && remaining !== null) limit = used + remaining;
    if (used === null && limit !== null && remaining !== null) used = limit - remaining;
    if (limit !== null && limit > 0 && used !== null) percent = used / limit * 100;
  }
  if (percent === null) return null;
  let reset: number | null = null;
  for (const key of resetKeys) {
    const number = finiteNumber(payload[key]);
    reset = number !== null && number > 1_000_000_000_000 ? number / 1000
      : number !== null && number > 1_000_000_000 ? number : isoToSeconds(payload[key]);
    if (reset !== null) break;
  }
  const length = duration(payload) ?? minutes;
  return feedWindow(length, Math.max(0, Math.min(100, percent)), reset, now, length === null ? "quota" : undefined);
}

function parseUsage(value: unknown, now: number): FeedWindow[] | null {
  const root = Array.isArray(value) ? { quotas: value } : value;
  if (!isRecord(root)) return null;
  const data = isRecord(root.data) ? root.data : {};
  const known = (key: string): Record<string, unknown> | null => quota(root[key]) ? root[key] : quota(data[key]) ? data[key] : null;
  const weekly = known("planWeeklyLimit");
  const search = isRecord(root.search) ? root.search.hourly : null;
  const dataSearch = isRecord(data.search) ? data.search.hourly : null;
  const slots = [
    { payload: weekly ? null : known("rollingFiveHourLimit"), minutes: 300, points: false },
    { payload: weekly ?? known("weeklyTokenLimit"), minutes: 10080, points: weekly !== null },
    { payload: quota(search) ? search : quota(dataSearch) ? dataSearch : null, minutes: 60, points: false },
  ];
  if (slots.some((slot) => slot.payload !== null)) {
    const windows = slots.flatMap(({ payload, minutes, points }) => {
      const window = payload && parseQuota(payload, now, minutes, points);
      return window ? [window] : [];
    });
    return windows.length ? windows : null;
  }
  for (const candidate of [root.quotas, root.quota, root.limits, root.usage, root.entries, root.subscription, root.data,
    data.quotas, data.quota, data.limits, data.usage, data.entries, data.subscription]) {
    const entries = collect(candidate);
    if (!entries.length) continue;
    const windows = entries.flatMap((entry) => {
      const window = parseQuota(entry, now, null);
      return window ? [window] : [];
    });
    return windows.length ? windows : null;
  }
  return null;
}

export const synthetic: Provider = {
  id: "synthetic",
  name: "Synthetic",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "synthetic", ["SYNTHETIC_API_KEY"]);
    if (!key) throw new NotConfigured("Synthetic");
    const now = context.now();
    const base: FeedAccount = {
      provider: "synthetic", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const response = await context.fetch("https://api.synthetic.new/v2/quotas", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Synthetic", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Synthetic", response.status);
    let body: unknown;
    try { body = await response.json(); } catch { throw new HttpError("Synthetic", response.status); }
    const windows = parseUsage(body, now);
    if (!windows) throw new HttpError("Synthetic", response.status);
    const data = isRecord(body) && isRecord(body.data) ? body.data : {};
    const email = isRecord(body) ? firstString(body, ["email"]) ?? firstString(data, ["email"]) : null;
    return [{ ...base, account: accountLabel(email), blocked: windows.some((window) => (window.used_percent ?? 0) >= 100),
      windows: windows.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity)).slice(0, 2) }];
  },
};
