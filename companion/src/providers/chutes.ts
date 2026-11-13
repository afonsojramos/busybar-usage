import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  isProviderHost,
  type Context,
  type Provider,
} from "./types.ts";

const ID = "chutes";

function base(context: Context): FeedAccount {
  return {
    provider: ID,
    account: accountLabel(null),
    blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(),
    windows: [],
  };
}

async function request(context: Context, url: string | URL, key: string, init: RequestInit = {}): Promise<unknown> {
  const response = await context.fetch(url, {
    ...init,
    redirect: "error",
    headers: { Accept: "application/json", Authorization: `Bearer ${key}`, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403) throw new HttpError(ID, response.status);
  if (response.status === 429) throw new RateLimited(ID, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(ID, response.status);
  try {
    return await response.json();
  } catch {
    throw new HttpError(ID, response.status);
  }
}

function finish(context: Context, windows: FeedWindow[], blocked = false): FeedAccount[] {
  return [
    {
      ...base(context),
      windows: windows.slice(0, 2),
      blocked: blocked || windows.some((window) => (window.used_percent ?? 0) >= 100),
    },
  ];
}

function signIn(context: Context, error: unknown): FeedAccount[] {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return [{ ...base(context), error: "sign in" }];
  }
  throw error;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(ID, 200);
  return value;
}

function endpoint(raw: string, hosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new NotConfigured(ID);
  }
  if (!isProviderHost(url, hosts) || url.username || url.password) throw new NotConfigured(ID);
  return url;
}

const aliases = {
  rolling: ["rolling", "rollingwindow", "rolling4h", "fourhour", "fourhourusage", "window4h"],
  monthly: ["monthly", "monthlyusage", "subscription", "subscriptionusage", "billingperiod"],
  label: ["label", "name", "title", "type", "quotatype", "period", "window", "windowname", "chuteid"],
  limit: [
    "limit",
    "cap",
    "max",
    "maximum",
    "quota",
    "quotalimit",
    "monthlycap",
    "monthlylimit",
    "requestlimit",
    "tokenlimit",
    "hardlimit",
    "total",
  ],
  used: [
    "used",
    "usage",
    "usedamount",
    "consumed",
    "consumedamount",
    "current",
    "currentusage",
    "requests",
    "requestcount",
    "tokens",
    "tokenusage",
    "monthlyusage",
  ],
  remaining: ["remaining", "available", "balance", "left", "remainingamount", "availableamount"],
  percent: ["percentused", "usagepercent", "usedpercent", "utilization", "utilizationpercent"],
  reset: [
    "resetat",
    "resetsat",
    "resettime",
    "nextresetat",
    "renewsat",
    "renewalat",
    "periodend",
    "currentperiodend",
    "expiresat",
    "windowend",
    "endtime",
  ],
};
function field(record: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    const key = Object.keys(record).find((key) => key.toLowerCase().replace(/[^a-z0-9]/g, "") === name);
    if (key !== undefined) return record[key];
  }
  return undefined;
}
function numeric(value: unknown): number | null {
  return finiteNumber(
    typeof value === "string" ? value.trim().replace(/[,$%]/g, "") : typeof value === "boolean" ? Number(value) : value,
  );
}
function duration(record: Record<string, unknown>): number | null {
  for (const [unit, multiplier] of [
    ["minutes", 1],
    ["hours", 60],
    ["days", 1440],
    ["seconds", 1 / 60],
  ] satisfies [string, number][]) {
    const value = numeric(field(record, [`window${unit}`, `period${unit}`, `duration${unit}`]));
    if (value !== null)
      return Number.isSafeInteger(Math.round(value * multiplier)) && Math.round(value * multiplier) > 0
        ? Math.round(value * multiplier)
        : null;
  }
  const text = field(record, ["window", "period", "interval", "duration"]);
  const match =
    typeof text === "string"
      ? text
          .toLowerCase()
          .replace(/ /g, "")
          .match(/^([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(.+)$/)
      : null;
  if (!match) return null;
  const multiplier = /^(min|m$)/.test(match[2])
    ? 1
    : /^(hour|hr|h$)/.test(match[2])
      ? 60
      : /^(day|d$)/.test(match[2])
        ? 1440
        : /^(month|mo$)/.test(match[2])
          ? 43200
          : NaN;
  const minutes = Math.round(Number(match[1]) * multiplier);
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes : null;
}
interface Quota {
  window: FeedWindow;
  kind: "rolling" | "monthly" | "other";
}
function parse(value: unknown, context: Context): Quota[] {
  const quotas: Quota[] = [];
  const seen = new Set<string>();
  function collect(value: unknown, implied: "rolling" | "monthly" | "other" = "other", depth = 0): void {
    if (depth > 20) throw new HttpError(ID, 200);
    if (Array.isArray(value)) {
      value.forEach((v) => collect(v, implied, depth + 1));
      return;
    }
    if (!isRecord(value)) return;
    const read = (names: string[]) => numeric(field(value, names));
    const limit = read(aliases.limit),
      used = read(aliases.used),
      remaining = read(aliases.remaining);
    const total = limit ?? (used !== null && remaining !== null ? used + remaining : null);
    const consumed = used ?? (total !== null && remaining !== null ? total - remaining : null);
    const normalize = (n: number) => Math.min(100, Math.max(0, Math.abs(n) < 1 ? n * 100 : n));
    const percent = read(aliases.percent),
      remainingPercent = read(["percentremaining", "remainingpercent"]);
    const usedPercent =
      percent !== null
        ? normalize(percent)
        : remainingPercent !== null
          ? 100 - normalize(remainingPercent)
          : total !== null && total > 0 && consumed !== null
            ? (consumed / total) * 100
            : null;
    if (usedPercent !== null) {
      const label = String(field(value, aliases.label) ?? "").toLowerCase();
      const minutes = duration(value);
      const kind =
        implied !== "other"
          ? implied
          : /rolling|4h|4 h|4-hour|four.hour/.test(label) || minutes === 240
            ? "rolling"
            : /month|billing|subscription/.test(label) || (minutes ?? 0) >= 40320
              ? "monthly"
              : "other";
      const resetValue = field(value, aliases.reset);
      const epoch = numeric(resetValue);
      const reset = epoch !== null && epoch > 0 ? (epoch > 1e10 ? epoch / 1000 : epoch) : isoToSeconds(resetValue);
      const window = feedWindow(
        minutes ?? (kind === "rolling" ? 240 : kind === "monthly" ? 43200 : null),
        Math.min(100, Math.max(0, usedPercent)),
        reset,
        context.now(),
        minutes === null && kind === "other" ? "quota" : undefined,
      );
      const key = JSON.stringify(window);
      if (!seen.has(key)) {
        seen.add(key);
        quotas.push({ window, kind });
      }
    }
    for (const [key, nested] of Object.entries(value)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      collect(
        nested,
        aliases.rolling.includes(normalized) ? "rolling" : aliases.monthly.includes(normalized) ? "monthly" : "other",
        depth + 1,
      );
    }
  }
  collect(value);
  return quotas;
}
function selected(quotas: Quota[]): FeedWindow[] {
  const rolling = quotas.find((q) => q.kind === "rolling");
  const monthly = quotas.find((q) => q.kind === "monthly");
  const fallback = quotas.filter((q) => q.kind === "other");
  return [rolling, monthly, ...fallback]
    .filter((q): q is Quota => q !== undefined)
    .slice(0, 2)
    .map((q) => q.window)
    .sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
}
function requiredError(error: unknown): void {
  if (
    error instanceof RateLimited ||
    (error instanceof HttpError && [401, 403].includes(error.status)) ||
    (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
  )
    throw error;
}
export const chutes: Provider = {
  id: ID,
  name: "Chutes",
  async fetch(context) {
    const key = await apiKey(context, ID, ["CHUTES_API_KEY"]);
    if (!key) throw new NotConfigured(ID);
    const baseURL = endpoint(context.env.CHUTES_API_URL || "https://api.chutes.ai", ["api.chutes.ai"]);
    async function get(path: string): Promise<unknown> {
      const url = new URL(baseURL);
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/users/me/${path}`;
      const data = await request(context, url, key!);
      if (!isRecord(data) && !Array.isArray(data)) throw new HttpError(ID, 200);
      return data;
    }
    try {
      const quotas = parse(await get("subscription_usage"), context);
      if (!quotas.some((q) => q.kind === "rolling") || !quotas.some((q) => q.kind === "monthly")) {
        try {
          const raw = await get("quotas");
          const root = isRecord(raw) ? raw : {};
          const list = [raw, root.quotas, root.data, isRecord(root.data) ? root.data.quotas : null].find(Array.isArray);
          let extra = parse(raw, context);
          if (list?.some(isRecord)) {
            const enriched: Record<string, unknown>[] = [];
            for (const item of list) {
              if (!isRecord(item)) continue;
              const id = item.chute_id ?? item.chuteId ?? item.id;
              let usage: Record<string, unknown> = {};
              if (typeof id === "string" || typeof id === "number") {
                try {
                  const response = object(await get(`quota_usage/${encodeURIComponent(String(id))}`));
                  usage = isRecord(response.data)
                    ? response.data
                    : isRecord(response.result)
                      ? response.result
                      : response;
                } catch (error) {
                  requiredError(error);
                }
              }
              enriched.push({ ...item, ...usage });
            }
            const parsed = parse(enriched, context);
            if (parsed.length) extra = parsed;
          }
          for (const quota of extra)
            if (quota.kind === "other" || !quotas.some((q) => q.kind === quota.kind)) quotas.push(quota);
        } catch (error) {
          requiredError(error);
        }
      }
      return finish(context, selected(quotas));
    } catch (error) {
      return signIn(context, error);
    }
  },
};
