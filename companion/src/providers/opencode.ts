import { randomUUID } from "node:crypto";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  valueWindow,
  type FeedWindow,
} from "../feed.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const NAME = "OpenCode";
const ORIGIN = "https://opencode.ai";
const WORKSPACES = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
const SUBSCRIPTION = "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4";
const BILLING = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
const AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function workspace(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^(wrk_|org_)[A-Za-z0-9_-]+$/.test(value.trim())) return value.trim();
  try {
    const url = new URL(value);
    if (url.origin !== ORIGIN) return null;
    const id = /^\/(?:workspace|console)\/((?:wrk_|org_)[\w-]+)(?:\/|$)/.exec(url.pathname)?.[1];
    return id ?? null;
  } catch {
    return null;
  }
}
function date(value: unknown): number | null {
  const n = finiteNumber(value);
  return n === null ? isoToSeconds(value) : n > 10_000_000_000 ? n / 1000 : n;
}
async function text(
  context: Context,
  cookie: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<string> {
  const response = await context.fetch(ORIGIN + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Cookie: cookie, "User-Agent": AGENT, Accept: "application/json", ...headers },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  return response.text();
}
async function server(context: Context, cookie: string, id: string, org?: string, post = false): Promise<string> {
  const args = org ? [org] : [];
  const query = new URLSearchParams({ id });
  if (args.length) query.set("args", JSON.stringify(args));
  return text(
    context,
    cookie,
    post ? "/_server" : `/_server?${query}`,
    {
      "X-Server-Id": id,
      "X-Server-Instance": `server-fn:${randomUUID()}`,
      Origin: ORIGIN,
      Referer: org ? `${ORIGIN}/workspace/${org}/billing` : ORIGIN,
      Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
      ...(post ? { "Content-Type": "application/json" } : {}),
    },
    post ? JSON.stringify(args) : undefined,
  );
}
function quota(value: unknown, minutes: number, now: number): FeedWindow | null {
  if (!isRecord(value)) return null;
  const reported = finiteNumber(value.usagePercent ?? value.percent);
  const used = finiteNumber(value.used);
  const limit = finiteNumber(value.limit);
  const percent =
    reported === null
      ? used !== null && limit !== null && limit > 0
        ? (used / limit) * 100
        : null
      : reported <= 1
        ? reported * 100
        : reported;
  if (percent === null) return null;
  const interval = finiteNumber(value.resetInSec);
  return feedWindow(minutes, percent, interval === null ? date(value.resetAt ?? value.resetsAt) : now + interval, now);
}
export function parseOpenCodeSubscription(raw: string, now: number): FeedWindow[] | null {
  const root = json(raw);
  function find(value: unknown, depth: number): FeedWindow[] | null {
    if (depth > 10 || (!isRecord(value) && !Array.isArray(value))) return null;
    if (isRecord(value)) {
      const first = quota(value.rollingUsage ?? value.primaryWindow, 300, now);
      const second = quota(value.weeklyUsage ?? value.secondaryWindow, 10080, now);
      if (first && second) return [first, second];
    }
    if (Array.isArray(value) && value.length >= 2) {
      const first = quota(value[0], 300, now),
        second = quota(value[1], 10080, now);
      if (first && second) return [first, second];
    }
    for (const child of Object.values(value)) {
      const found = find(child, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const parsed = find(root, 0);
  if (parsed) return parsed;
  const windows: FeedWindow[] = [];
  for (const [key, minutes] of [
    ["rollingUsage", 300],
    ["weeklyUsage", 10080],
  ] satisfies [string, number][]) {
    const section = new RegExp(`${key}[^}]*`).exec(raw)?.[0];
    const percent = section && /usagePercent\s*:\s*(\d+(?:\.\d+)?)/.exec(section)?.[1];
    const reset = section && /resetInSec\s*:\s*(\d+)/.exec(section)?.[1];
    if (!percent || !reset) return null;
    windows.push(feedWindow(minutes, Number(percent), now + Number(reset), now));
  }
  return windows;
}
function dollars(value: number): string {
  return `$${value.toFixed(2)}`.slice(0, 12);
}
async function legacy(context: Context, cookie: string, id: string): Promise<FeedWindow[]> {
  let raw = await server(context, cookie, SUBSCRIPTION, id);
  let windows = parseOpenCodeSubscription(raw, context.now());
  if (windows) return windows;
  if (!/(?:^|[,)])\s*null\s*\)?\s*$/.test(raw.trim())) {
    raw = await server(context, cookie, SUBSCRIPTION, id, true);
    windows = parseOpenCodeSubscription(raw, context.now());
    if (windows) return windows;
  }
  raw = await server(context, cookie, BILLING, id);
  const payload = json(raw);
  const findCustomer = (value: unknown, depth = 0): Record<string, unknown> | null => {
    if (depth > 10 || (!isRecord(value) && !Array.isArray(value))) return null;
    if (isRecord(value) && typeof value.customerID === "string" && value.customerID.trim()) return value;
    for (const child of Object.values(value)) {
      const found = findCustomer(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  const customer = findCustomer(payload);
  if (!customer && !/customerID\s*:\s*"[^"]+"/.test(raw)) throw new HttpError(NAME, 200);
  const read = (key: string): number | null =>
    isRecord(customer)
      ? finiteNumber(customer[key])
      : finiteNumber(new RegExp(`${key}\\s*:\\s*(?:\\$R\\[\\d+\\]=)?(-?\\d+(?:\\.\\d+)?)`).exec(raw)?.[1]);
  const used = read("monthlyUsage"),
    limit = read("monthlyLimit"),
    balance = read("balance");
  if (
    used === null ||
    (customer && customer.subscription !== null && customer.subscription !== undefined) ||
    (!customer && /(?:^|[,{])subscription\s*:\s*(?!null)[^,}]+/.test(raw))
  )
    throw new HttpError(NAME, 200);
  const result =
    limit !== null && limit > 0
      ? [feedWindow(43200, (used / 1e8 / limit) * 100, null, context.now(), "30d")]
      : [valueWindow("30d", dollars(used / 1e8))];
  if (balance !== null) result.push(valueWindow("balance", dollars(balance / 1e8)));
  return result;
}
async function consoleUsage(context: Context, cookie: string, id: string): Promise<FeedWindow[]> {
  const get = async (path: string): Promise<unknown> => {
    const raw = await text(context, cookie, `/console/api/${path}`, { "x-org-id": id });
    const parsed = json(raw);
    if (parsed === null && raw.trim() !== "null") throw new HttpError(NAME, 200);
    return parsed;
  };
  const status = await get("go/status");
  const access = isRecord(status) && isRecord(status.access) ? status.access : null;
  const meters = access && isRecord(access.meters) ? access.meters : null;
  if (meters) {
    const result: FeedWindow[] = [];
    for (const [key, minutes] of [
      ["fiveHour", 300],
      ["week", 10080],
      ["month", 43200],
    ] satisfies [string, number][]) {
      const meter = meters[key];
      if (!isRecord(meter)) continue;
      const used = finiteNumber(meter.usedMicroCents),
        limit = finiteNumber(meter.limitMicroCents);
      if (used === null || limit === null || limit <= 0) continue;
      result.push(
        feedWindow(
          minutes,
          (used / limit) * 100,
          date(meter.resetsAt ?? (key === "month" ? access?.endsAt : null)),
          context.now(),
        ),
      );
    }
    if (!result.length || result[0].minutes !== 300) throw new HttpError(NAME, 200);
    return result.slice(0, 2);
  }
  if (status !== null && !(isRecord(status) && status.access === null)) throw new HttpError(NAME, 200);
  const org = await get("orgs/current"),
    billing = await get("billing/status");
  if (!isRecord(org) || org.hasGoSubscription !== false || !isRecord(billing) || billing.mode !== "pay-as-you-go")
    throw new HttpError(NAME, 200);
  const summary = await get("usage/summary?range=30d");
  const spent = isRecord(summary) ? finiteNumber(summary.totalCostMicroCents) : null;
  if (spent === null || spent < 0) throw new HttpError(NAME, 200);
  const result = [valueWindow("30d", dollars(spent / 1e8))];
  const balance = finiteNumber(billing.balanceMicroCents);
  if (balance !== null) result.push(valueWindow("balance", dollars(balance / 1e8)));
  return result;
}
export const opencode: Provider = {
  id: "opencode",
  name: NAME,
  async fetch(context) {
    const entry = await providerEntry(context, "opencode");
    if (entry.cookieSource === "off") throw new NotConfigured(NAME);
    if (entry.cookieSource === "manual" && (typeof entry.cookieHeader !== "string" || !entry.cookieHeader.trim()))
      throw new NotConfigured(NAME);
    const cached =
      entry.cookieSource !== "manual"
        ? await context.readKeychain("com.steipete.codexbar.cache", "cookie.opencode")
        : null;
    const cache = cached === null ? null : json(cached);
    const cachedHeader = isRecord(cache) && typeof cache.cookieHeader === "string" ? cache.cookieHeader : null;
    const base = {
      provider: "opencode",
      account: accountLabel(null),
      observed_at: new Date(context.now() * 1000).toISOString(),
      windows: [],
      blocked: false,
    };
    const fetchCookie = async (cookie: string) => {
      const override = entry.workspaceID ?? context.env.CODEXBAR_OPENCODE_WORKSPACE_ID;
      let id = workspace(override);
      if (override !== undefined && !id) throw new NotConfigured(NAME);
      const consoleSession = /(?:^|;\s*)__Host-console_session=/.test(cookie);
      if (!id) {
        const raw = consoleSession
          ? await text(context, cookie, "/console/api/orgs")
          : await server(context, cookie, WORKSPACES);
        const parsed = json(raw);
        if (Array.isArray(parsed))
          id = parsed.map((row) => (isRecord(row) ? workspace(row.id) : null)).find((row) => row !== null) ?? null;
        if (!id) id = workspace(/(?:wrk_|org_)[A-Za-z0-9_-]+/.exec(raw)?.[0]);
        if (!id && !consoleSession)
          id = workspace(
            /(?:wrk_|org_)[A-Za-z0-9_-]+/.exec(await server(context, cookie, WORKSPACES, undefined, true))?.[0],
          );
        if (!id) throw new HttpError(NAME, 200);
      }
      let windows: FeedWindow[];
      if (consoleSession) {
        try {
          windows = await consoleUsage(context, cookie, id);
        } catch (error) {
          if (!/(?:^|;\s*)auth=/.test(cookie) || error instanceof RateLimited) throw error;
          windows = await legacy(context, cookie, id);
        }
      } else windows = await legacy(context, cookie, id);
      return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
    };
    let rejected = false;
    if (cachedHeader) {
      try {
        return await fetchCookie(cachedHeader);
      } catch (error) {
        if (!(error instanceof HttpError) || (error.status !== 401 && error.status !== 403)) throw error;
        rejected = true;
      }
    }
    const cookie = await cookieHeader(context, "opencode", {
      domains: ["opencode.ai"],
      required: ["auth", "__Host-console_session"],
    });
    if (cookie && cookie !== cachedHeader) {
      try {
        return await fetchCookie(cookie);
      } catch (error) {
        if (!(error instanceof HttpError) || (error.status !== 401 && error.status !== 403)) throw error;
        rejected = true;
      }
    }
    if (rejected) return [{ ...base, error: "sign in" }];
    throw new NotConfigured(NAME);
  },
};
