import { join } from "node:path";
import { cookieHeader } from "../cookies.ts";
import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  valueWindow,
  type FeedAccount,
} from "../feed.ts";
import {
  HttpError,
  isProviderHost,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  type Context,
  type Provider,
} from "./types.ts";

const NAME = "MiMo";
const HOST = "platform.xiaomimimo.com";
const COOKIE_NAMES = ["api-platform_serviceToken", "userId", "api-platform_ph", "api-platform_slh"];

function base(context: Context): FeedAccount {
  return {
    provider: "mimo",
    account: accountLabel(null),
    blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(),
    windows: [],
  };
}

function compact(value: number): string {
  if (Math.abs(value) >= 1e12) return value.toExponential(1);
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}

async function localUsage(context: Context): Promise<FeedAccount | null> {
  const rawPath = context.env.MIMO_LOCAL_USAGE_PATH?.trim();
  const path = rawPath?.startsWith("~/")
    ? join(context.home, rawPath.slice(2))
    : rawPath || join(context.home, ".codexbar", "mimo-local-usage.json");
  const text = await context.readFile(path);
  if (text === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(NAME, 200);
  }
  if (!isRecord(data) || !isRecord(data.windows)) throw new HttpError(NAME, 200);
  const windows = data.windows;
  if (!isRecord(windows.today) || !isRecord(windows.week) || !isRecord(windows.all_time)) {
    throw new HttpError(NAME, 200);
  }
  const result = base(context);
  const updated = isoToSeconds(data.updated_at);
  if (updated !== null) result.observed_at = new Date(updated * 1000).toISOString();
  for (const [key, name] of [
    ["today", "today"],
    ["week", "7d"],
  ]) {
    const window = windows[key];
    if (!isRecord(window)) continue;
    const sum = ["input", "output", "cache_read", "cache_create"].reduce(
      (total, field) => total + Math.max(0, Math.trunc(finiteNumber(window[field]) ?? 0)),
      0,
    );
    if (!Number.isFinite(sum)) throw new HttpError(NAME, 200);
    result.windows.push(valueWindow(name, `${compact(sum)} tok`));
  }
  return result;
}

function normalizedCookie(raw: string): string | null {
  const pairs = new Map<string, string>();
  for (const pair of raw.replace(/^Cookie:\s*/i, "").split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (COOKIE_NAMES.includes(name) && value) pairs.set(name, value);
  }
  if (!pairs.has("api-platform_serviceToken") || !pairs.has("userId")) return null;
  return [...pairs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

async function request(context: Context, url: string, cookie: string): Promise<unknown> {
  const response = await context.fetch(url, {
    headers: {
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      "Accept-Language": "en-US,en;q=0.9",
      "x-timeZone": "UTC+01:00",
      Origin: `https://${HOST}`,
      Referer: `https://${HOST}/#/console/balance`,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new HttpError(NAME, response.status);
  }
  if (!isRecord(json)) throw new HttpError(NAME, response.status);
  if (json.code === 401 || json.code === 403) throw new HttpError(NAME, json.code);
  if (json.code !== 0 || !isRecord(json.data)) throw new HttpError(NAME, response.status);
  return json.data;
}

export const mimo: Provider = {
  id: "mimo",
  name: NAME,
  async fetch(context) {
    let apiURL: URL;
    try {
      const override = context.env.MIMO_API_URL?.trim();
      apiURL = new URL(
        override ? (/^https?:\/\//i.test(override) ? override : `https://${override}`) : `https://${HOST}/api/v1`,
      );
    } catch {
      throw new NotConfigured(NAME);
    }
    if (!isProviderHost(apiURL, [HOST]) || apiURL.username || apiURL.password || apiURL.search || apiURL.hash) {
      throw new NotConfigured(NAME);
    }
    const raw = await cookieHeader(context, "mimo", {
      domains: [HOST, "xiaomimimo.com"],
      required: ["api-platform_serviceToken", "userId"],
    });
    const cookie = raw ? normalizedCookie(raw) : null;
    if (!cookie) {
      const local = await localUsage(context);
      if (local) return [local];
      throw new NotConfigured(NAME);
    }
    const endpoint = apiURL.toString().replace(/\/$/, "");
    const result = base(context);
    let balance: unknown;
    try {
      balance = await request(context, `${endpoint}/balance`, cookie);
    } catch (error) {
      if (
        error instanceof HttpError &&
        ([401, 403].includes(error.status) || (error.status >= 300 && error.status < 400))
      ) {
        return [{ ...result, error: "sign in" }];
      }
      throw error;
    }
    if (!isRecord(balance)) throw new HttpError(NAME, 200);
    const amount = finiteNumber(balance.balance);
    const currency = typeof balance.currency === "string" ? balance.currency.trim() : "";
    if (amount === null || !/^[A-Za-z]{3}$/.test(currency)) throw new HttpError(NAME, 200);
    const symbol =
      currency.toUpperCase() === "USD" ? "$" : currency.toUpperCase() === "CNY" ? "¥" : `${currency.toUpperCase()} `;
    const money = `${symbol}${amount.toFixed(2)}`;
    const balanceWindow = valueWindow(
      "balance",
      money.length <= 12 ? money : `${symbol}${compact(amount)}`.slice(0, 12),
    );
    // Plan endpoints are optional in CodexBar; balance remains useful if they are unavailable.
    const [detailResult, usageResult] = await Promise.allSettled([
      request(context, `${endpoint}/tokenPlan/detail`, cookie),
      request(context, `${endpoint}/tokenPlan/usage`, cookie),
    ]);
    const detail = detailResult.status === "fulfilled" && isRecord(detailResult.value) ? detailResult.value : null;
    const usage = usageResult.status === "fulfilled" && isRecord(usageResult.value) ? usageResult.value : null;
    const month = usage && isRecord(usage.monthUsage) ? usage.monthUsage : null;
    const item = month && Array.isArray(month.items) && isRecord(month.items[0]) ? month.items[0] : null;
    const limit = item ? finiteNumber(item.limit) : null;
    const percent = item ? finiteNumber(item.percent) : null;
    if (limit !== null && limit > 0 && percent !== null && Number.isFinite(percent * 100)) {
      const end = typeof detail?.currentPeriodEnd === "string" ? detail.currentPeriodEnd : null;
      const reset = end ? isoToSeconds(end.replace(" ", "T") + (/Z$|[+-]\d\d:\d\d$/.test(end) ? "" : "Z")) : null;
      result.windows.push(
        feedWindow(
          reset === null ? null : 43200,
          percent * 100,
          reset,
          context.now(),
          reset === null ? "credit" : "30d",
        ),
      );
    }
    result.windows.push(balanceWindow);
    result.blocked = result.windows.some((window) => (window.used_percent ?? 0) >= 100);
    return [result];
  },
};
