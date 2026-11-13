import { randomUUID } from "node:crypto";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, isProviderHost, type Context, type Provider } from "./types.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
class SignIn extends Error {}
function expand(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new HttpError(NAME, 200);
  if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
    try { return expand(JSON.parse(value), depth + 1); } catch { return value; }
  }
  if (Array.isArray(value)) return value.map((child) => expand(child, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, depth + 1)]));
  return value;
}
function objects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(objects);
  if (!isRecord(value)) return [];
  return [value, ...Object.values(value).flatMap(objects)];
}
function date(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && n > 1e9 ? n / (n > 1e12 ? 1000 : 1) : isoToSeconds(value);
}
function cookieValue(header: string, key: string): string | undefined {
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1);
}
function endpoint(raw: string | undefined, fallback: string, hosts: string[]): URL {
  let url: URL;
  try { url = new URL(raw ? (raw.includes("://") ? raw : `https://${raw}`) : fallback); }
  catch { throw new NotConfigured(NAME); }
  if (!isProviderHost(url, hosts) || url.username || url.password) throw new NotConfigured(NAME);
  return url;
}
async function request(context: Context, url: URL | string, init: RequestInit = {}): Promise<Response> {
  const response = await context.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (response.status === 401 || response.status === 403) throw new SignIn();
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  return response;
}
async function jsonResponse(response: Response): Promise<unknown> {
  let root: unknown;
  try { root = expand(await response.json()); } catch { throw new HttpError(NAME, response.status); }
  if (!isRecord(root)) throw new HttpError(NAME, response.status);
  for (const object of objects(root)) {
    const code = object.code ?? object.Code;
    if (typeof code === "string" && /needlogin|notlogined|no_login/i.test(code)) throw new SignIn();
    if (object.successResponse === false || object.Success === false || object.success === false) throw new HttpError(NAME, 200);
  }
  return root;
}
function headers(cookie: string, origin: string, dashboard: string): Record<string, string> {
  const result: Record<string, string> = { Cookie: cookie, Origin: origin, Referer: dashboard,
    "User-Agent": UA, Accept: "application/json, text/plain, */*", "X-Requested-With": "XMLHttpRequest",
    "Content-Type": "application/x-www-form-urlencoded" };
  const csrf = cookieValue(cookie, "login_aliyunid_csrf") ?? cookieValue(cookie, "csrf");
  if (csrf) { result["x-xsrf-token"] = csrf; result["x-csrf-token"] = csrf; }
  return result;
}
async function secToken(context: Context, origin: string, dashboard: string, cookie: string): Promise<string | null> {
  const response = await request(context, dashboard, { headers: { Cookie: cookie, "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" } });
  const html = await response.text();
  const match = /(?:secToken|sec_token|SEC_TOKEN)["']?\s*[:=]\s*["']([^"']+)["']/.exec(html);
  if (match?.[1]) return match[1];
  const cached = cookieValue(cookie, "sec_token");
  if (cached) return cached;
  const info = await jsonResponse(await request(context, `${origin}/tool/user/info.json`, { headers: { Cookie: cookie, "User-Agent": UA, Referer: `${origin}/`, Accept: "application/json, text/plain, */*" } }));
  for (const object of objects(info)) {
    const token = object.secToken ?? object.sec_token;
    if (typeof token === "string" && token.trim()) return token;
  }
  return null;
}
function cornerstone(origin: string, dashboard: string, site: string, cookie: string) {
  const cna = cookieValue(cookie, "cna");
  return { feTraceId: randomUUID(), feURL: dashboard, protocol: "V2", console: "ONE_CONSOLE",
    productCode: "p_efm", domain: new URL(origin).host, consoleSite: site,
    userNickName: "", userPrincipalName: "", xsp_lang: "en-US", ...(cna ? { "X-Anonymous-Id": cna } : {}) };
}
function personalWindows(root: unknown, now: number): FeedWindow[] {
  const usage = objects(root).find((object) => ["per5HourPercentage", "per1WeekPercentage", "per1MonthPercentage"].some((key) => key in object));
  if (!usage) throw new HttpError(NAME, 200);
  const windows: FeedWindow[] = [];
  for (const [prefix, minutes] of [["per5Hour", 300], ["per1Week", 10080], ["per1Month", 43200]] as const) {
    const ratio = finiteNumber(usage[`${prefix}Percentage`]);
    if (ratio === null) continue;
    if (ratio < 0 || ratio > 1) throw new HttpError(NAME, 200);
    windows.push(feedWindow(minutes, ratio * 100, date(usage[`${prefix}ResetTime`]), now));
  }
  if (!windows.length) throw new HttpError(NAME, 200);
  return windows.slice(0, 2);
}
function base(context: Context): FeedAccount {
  return { provider: ID, provider_name: NAME, account: accountLabel(null), blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(), windows: [] };
}

const ID = "alibabatokenplan";
const NAME = "Alibaba Token Plan";
const HOSTS = ["modelstudio.console.alibabacloud.com", "bailian.console.aliyun.com", "bailian-singapore-cs.alibabacloud.com", "bailian-cs.console.aliyun.com"];
function teamWindows(root: unknown, now: number): FeedWindow[] {
  const all = objects(root);
  const totalKeys = ["totalQuota", "total_quota", "totalCredits", "totalCredit", "quota", "creditLimit", "creditsTotal", "monthlyTotalQuota", "amount", "totalValue", "TotalValue", "cycleTotalValue", "CycleTotalValue"];
  const remainingKeys = ["remainingQuota", "remainQuota", "remainingCredits", "remainingCredit", "availableCredits", "balance", "remaining", "availableAmount", "remainAmount", "totalSurplusValue", "TotalSurplusValue", "surplusValue", "SurplusValue", "cycleSurplusValue", "CycleSurplusValue"];
  const usedKeys = ["usedQuota", "used_quota", "usedCredits", "usedCredit", "consumedCredits", "usage", "used", "usedAmount", "consumeAmount", "usedValue", "UsedValue", "consumedValue", "ConsumedValue"];
  const summary = all.find((o) => totalKeys.some((k) => finiteNumber(o[k]) !== null));
  if (!summary) {
    if (all.some((o) => finiteNumber(o.TotalCount ?? o.totalCount) !== null)) return [];
    throw new HttpError(NAME, 200);
  }
  const total = totalKeys.map((k) => finiteNumber(summary[k])).find((n) => n !== null) ?? null;
  const remaining = remainingKeys.map((k) => finiteNumber(summary[k])).find((n) => n !== null) ?? null;
  const used = usedKeys.map((k) => finiteNumber(summary[k])).find((n) => n !== null) ?? (total !== null && remaining !== null ? total - remaining : null);
  if (total === null || total <= 0 || used === null || used < 0 || used > total) throw new HttpError(NAME, 200);
  const resets = all.flatMap((o) => ["nextRefreshTime", "resetTime", "periodEndTime", "billingCycleEnd", "expireTime", "endTime", "EndTime", "cycleEndTime", "CycleEndTime", "nearestExpireDate", "NearestExpireDate"].map((k) => date(o[k]))).filter((n): n is number => n !== null);
  return [feedWindow(43200, used / total * 100, resets.length ? Math.min(...resets) : null, now)];
}
async function cliWindows(context: Context, cn: boolean, personal: boolean): Promise<FeedWindow[] | null> {
  if (personal) {
    const result = await context.run("bl", ["console", "call", "--api", "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage", "--data", "{}", "--console-region", cn ? "cn-beijing" : "ap-southeast-1", "--console-site", cn ? "domestic" : "international", "--output", "json"], { timeoutMs: 15000 });
    if (!result || result.code !== 0 || result.stdout.length > 65536) return null;
    try { return personalWindows(expand(JSON.parse(result.stdout)), context.now()); } catch { return null; }
  }
  let totalSeats: number | null = null;
  const seats: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const result = await context.run("bl", ["token-plan", "list-seats", "--page-no", String(page), "--page-size", "10", "--output", "json"], { timeoutMs: 15000, env: { BAILIAN_BASE_URL: cn ? "https://dashscope.aliyuncs.com" : "https://dashscope-intl.aliyuncs.com", DASHSCOPE_BASE_URL: cn ? "https://dashscope.aliyuncs.com" : "https://dashscope-intl.aliyuncs.com" } });
    if (!result || result.code !== 0 || result.stdout.length > 65536) return null;
    let root: unknown;
    try { root = JSON.parse(result.stdout); } catch { return null; }
    const data = isRecord(root) && root.Success === true && isRecord(root.Data) ? root.Data : null;
    if (!data || data.PageNo !== page || data.PageSize !== 10 || !Array.isArray(data.Items)) return null;
    const count = finiteNumber(data.Total);
    if (count === null || !Number.isInteger(count) || count < 0 || count > 1000 || (totalSeats !== null && totalSeats !== count)) return null;
    totalSeats = count;
    for (const seat of data.Items) {
      if (!isRecord(seat) || typeof seat.SeatId !== "string" || !seat.SeatId || seen.has(seat.SeatId)) return null;
      seen.add(seat.SeatId); seats.push(seat);
    }
    if (seats.length > count || (seats.length < count && data.Items.length !== 10)) return null;
    if (seats.length === count) break;
  }
  if (seats.length !== totalSeats) return null;
  let total = 0;
  let remaining = 0;
  const ends = new Set<number>();
  const now = context.now() * 1000;
  for (const seat of seats) {
    if (seat.Status !== "NORMAL") continue;
    const start = finiteNumber(seat.StartTime), end = finiteNumber(seat.EndTime);
    if (start === null || end === null || start <= 0 || end <= start) return null;
    if (now < start || now >= end) continue;
    const equities = Array.isArray(seat.EquityList) ? seat.EquityList.filter((e) => isRecord(e) && e.EquityType === "CREDITS") : [];
    if (equities.length !== 1 || !isRecord(equities[0])) return null;
    const equity = equities[0];
    const cycleStart = finiteNumber(equity.CycleStartTime), cycleEnd = finiteNumber(equity.CycleEndTime);
    const t = finiteNumber(equity.CycleTotalValue), r = finiteNumber(equity.CycleSurplusValue);
    if (cycleStart === null || cycleEnd === null || cycleStart > now || cycleEnd <= now || t === null || r === null || t < 0 || r < 0 || r > t) return null;
    total += t; remaining += r; ends.add(cycleEnd / 1000);
  }
  if (!Number.isFinite(total) || total <= 0) return null;
  return [feedWindow(43200, (total - remaining) / total * 100, ends.size === 1 ? [...ends][0] : null, context.now())];
}
export const alibabatokenplan: Provider = {
  id: ID, name: NAME,
  // Runs the bl CLI, possibly several pages of it; CodexBar refreshes about this often.
  minIntervalSeconds: 300,
  async fetch(context) {
    const entry = await providerEntry(context, ID);
    const cn = typeof entry.region === "string" && entry.region.startsWith("cn");
    const personal = typeof entry.region === "string" && entry.region.endsWith("-personal");
    const cli = await cliWindows(context, cn, personal);
    const account = base(context);
    if (cli) return [{ ...account, windows: cli, blocked: cli.some((w) => (w.used_percent ?? 0) >= 100) }];
    if (entry.cookieSource === "off" || (entry.cookieSource === "manual" && (typeof entry.cookieHeader !== "string" || !entry.cookieHeader.trim()))) throw new NotConfigured(NAME);
    const origin = endpoint(context.env.ALIBABA_TOKEN_PLAN_HOST, cn ? "https://bailian.console.aliyun.com" : "https://modelstudio.console.alibabacloud.com", HOSTS).origin;
    const apiOrigin = context.env.ALIBABA_TOKEN_PLAN_HOST ? origin : personal ? (cn ? "https://bailian-cs.console.aliyun.com" : "https://bailian-singapore-cs.alibabacloud.com") : origin;
    const apiCookie = await cookieHeader(context, ID, { domains: [new URL(apiOrigin).host], envNames: ["ALIBABA_TOKEN_PLAN_COOKIE"] });
    if (!apiCookie) throw new NotConfigured(NAME);
    const dashboardCookie = await cookieHeader(context, ID, { domains: [new URL(origin).host], envNames: ["ALIBABA_TOKEN_PLAN_COOKIE"] }) ?? apiCookie;
    const region = cn ? "cn-beijing" : "ap-southeast-1";
    const dashboard = `${origin}/${region}${cn ? "" : "/"}?tab=plan#/efm/subscription/token-plan${personal ? "/personal" : ""}`;
    try {
      let token: string | null;
      try { token = await secToken(context, origin, dashboard, dashboardCookie); }
      catch (error) {
        if (error instanceof SignIn || error instanceof RateLimited) throw error;
        // Token Plan accepts cookie-only requests when optional console metadata is unavailable.
        token = cookieValue(dashboardCookie, "sec_token") ?? cookieValue(apiCookie, "sec_token") ?? null;
      }
      const api = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
      const action = personal ? (cn ? "BroadScopeAspnGateway" : "IntlBroadScopeAspnGateway") : "GetSubscriptionSummary";
      const product = personal ? "sfm_bailian" : "BssOpenAPI-V3";
      const url = endpoint(context.env.ALIBABA_TOKEN_PLAN_QUOTA_URL, `${apiOrigin}/data/api.json`, HOSTS);
      if (!context.env.ALIBABA_TOKEN_PLAN_QUOTA_URL) url.search = new URLSearchParams({ action, product, ...(personal ? { api, _v: "undefined" } : { _tag: "" }) }).toString();
      const params = personal ? { Api: api, V: "1.0", Data: { cornerstoneParam: { ...cornerstone(origin, dashboard, cn ? "BAILIAN_ALIYUN" : "MODELSTUDIO_ALBABACLOUD", apiCookie), switchUserType: 3 } } } : { ProductCode: cn ? "sfm_tokenplanteams_dp_cn" : "sfm_tokenplanteams_dp_intl" };
      const form = new URLSearchParams({ product, action, region, params: JSON.stringify(params), ...(personal ? { language: "en-US" } : {}), ...(token ? { sec_token: token } : {}) });
      const root = await jsonResponse(await request(context, url, { method: "POST", headers: headers(apiCookie, origin, dashboard), body: form }));
      const windows = personal ? personalWindows(root, context.now()) : teamWindows(root, context.now());
      return [{ ...account, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...account, error: "sign in" }];
      throw error;
    }
  },
};
