import { randomUUID } from "node:crypto";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, isProviderHost, type Context, type Provider } from "./types.ts";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
class SignIn extends Error {}
function expand(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new HttpError(NAME, 200);
  if (typeof value === "string" && /^[[{]/.test(value.trim())) {
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

const ID = "qwencloud";
const NAME = "Qwen Cloud";
const HOSTS = ["home.qwencloud.com", "cs-data.qwencloud.com"];
function teamWindows(root: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(root)) throw new HttpError(NAME, 200);
  const data = root.Data;
  if (data === null || (isRecord(data) && Object.keys(data).length === 0)) return null;
  if (!isRecord(data) || !Array.isArray(data.SubscriptionGroupList)) throw new HttpError(NAME, 200);
  const groups = data.SubscriptionGroupList;
  if (!groups.length) return null;
  const start = finiteNumber(data.StartTime), end = finiteNumber(data.EndTime);
  if (start === null || end === null || start <= 0 || end <= start) throw new HttpError(NAME, 200);
  if (now * 1000 < start || now * 1000 >= end) return null;
  if (data.ProductCode !== "sfm_tokenplanteams_dp_intl" || groups.length !== 1 || !isRecord(groups[0])) throw new HttpError(NAME, 200);
  const group = groups[0];
  if (!Array.isArray(group.EquityList)) throw new HttpError(NAME, 200);
  const equities = group.EquityList.filter((e) => isRecord(e) && e.EquityCode === "credit_value");
  if (equities.length !== 1 || !isRecord(equities[0])) throw new HttpError(NAME, 200);
  const total = finiteNumber(equities[0].TotalValue), remaining = finiteNumber(equities[0].SurplusValue);
  if (total === null || remaining === null || total <= 0 || remaining < 0 || remaining > total || total > Number.MAX_SAFE_INTEGER) throw new HttpError(NAME, 200);
  const reset = group.NextCycleFlushTime == null ? null : finiteNumber(group.NextCycleFlushTime);
  if (group.NextCycleFlushTime != null && (reset === null || reset <= 0)) throw new HttpError(NAME, 200);
  return [feedWindow(null, (total - remaining) / total * 100, reset === null ? null : reset / 1000, now, "Team")];
}
async function team(context: Context, cookie: string): Promise<FeedWindow[] | null> {
  const origin = "https://home.qwencloud.com";
  const h = headers(cookie, origin, `${origin}/analytics/token-plan/team`);
  const info = await jsonResponse(await request(context, `${origin}/tool/user/info.json`, { headers: h }));
  const data = isRecord(info) && isRecord(info.data) ? info.data : null;
  if (typeof data?.secToken !== "string" || !data.secToken.trim()) throw new SignIn();
  const token = data.secToken;
  async function rpc(product: string, action: string, params: Record<string, string>, region: string) {
    const result = await jsonResponse(await request(context, `${origin}/data/api.json?product=${product}&action=${action}`, { method: "POST", headers: h, body: new URLSearchParams({ product, action, sec_token: token, region, params: JSON.stringify(params), ...(action === "GetSeatSubscriptionSummary" ? { language: "zh-CN" } : {}) }) }));
    if (!isRecord(result) || (result.successResponse !== true && result.code !== "200") || !isRecord(result.data)) throw new HttpError(NAME, 200);
    return result.data;
  }
  const human = await rpc("ea-service", "LoadHumanInfo", {}, "ap-southeast-1");
  const humanData = isRecord(human.Data) ? human.Data : null;
  const seller = humanData && isRecord(humanData.SellerInfoDto) ? humanData.SellerInfoDto : null;
  const nbid = seller?.Nbid;
  if (nbid != null && nbid !== "" && (typeof nbid !== "string" || !nbid.trim())) throw new HttpError(NAME, 200);
  return teamWindows(await rpc("BssOpenAPI-V3", "GetSeatSubscriptionSummary", { productCode: "sfm_tokenplanteams_dp_intl", ...(typeof nbid === "string" && nbid ? { Nbid: nbid } : {}) }, "cn-hangzhou"), context.now());
}
export const qwencloud: Provider = {
  id: ID, name: NAME,
  async fetch(context) {
    const entry = await providerEntry(context, ID);
    if (entry.cookieSource === "off" || (entry.cookieSource === "manual" && (typeof entry.cookieHeader !== "string" || !entry.cookieHeader.trim()))) throw new NotConfigured(NAME);
    const origin = endpoint(context.env.QWEN_CLOUD_HOST, "https://home.qwencloud.com", HOSTS).origin;
    const apiOrigin = context.env.QWEN_CLOUD_HOST ? origin : "https://cs-data.qwencloud.com";
    const dashboardCookie = await cookieHeader(context, ID, { domains: [new URL(origin).host], envNames: ["QWEN_CLOUD_COOKIE"] });
    const apiCookie = await cookieHeader(context, ID, { domains: [new URL(apiOrigin).host], envNames: ["QWEN_CLOUD_COOKIE"] });
    const cookie = apiCookie ?? dashboardCookie;
    if (!cookie) throw new NotConfigured(NAME);
    const account = base(context);
    try {
      if (!context.env.QWEN_CLOUD_HOST && !context.env.QWEN_CLOUD_QUOTA_URL && dashboardCookie) {
        try {
          const windows = await team(context, dashboardCookie);
          if (windows) return [{ ...account, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
        } catch (error) { if (!(error instanceof HttpError)) throw error; }
      }
      const dashboard = `${origin}/billing/subscription/token-plan-individual`;
      const token = await secToken(context, origin, dashboard, dashboardCookie ?? cookie);
      if (!token) throw new SignIn();
      const api = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
      const url = endpoint(context.env.QWEN_CLOUD_QUOTA_URL, `${apiOrigin}/data/api.json`, HOSTS);
      if (!context.env.QWEN_CLOUD_QUOTA_URL) url.search = new URLSearchParams({ action: "IntlBroadScopeAspnGateway", product: "sfm_bailian", api, _v: "undefined" }).toString();
      const params = { Api: api, V: "1.0", Data: { cornerstoneParam: cornerstone(origin, dashboard, "QWENCLOUD", cookie) } };
      const root = await jsonResponse(await request(context, url, { method: "POST", headers: headers(cookie, origin, dashboard), body: new URLSearchParams({ product: "sfm_bailian", action: "IntlBroadScopeAspnGateway", region: "ap-southeast-1", language: "en-US", sec_token: token, params: JSON.stringify(params) }) }));
      const windows = personalWindows(root, context.now());
      return [{ ...account, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...account, error: "sign in" }];
      throw error;
    }
  },
};
