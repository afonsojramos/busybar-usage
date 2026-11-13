import { randomUUID } from "node:crypto";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
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
function base(context: Context): FeedAccount {
  return { provider: ID, provider_name: NAME, account: accountLabel(null), blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(), windows: [] };
}

const ID = "alibaba";
const NAME = "Alibaba";

const HOSTS = ["modelstudio.console.alibabacloud.com", "bailian.console.aliyun.com", "bailian-singapore-cs.alibabacloud.com", "bailian-cs.console.aliyun.com", "bailian-beijing-cs.aliyuncs.com"];
function codingWindows(root: unknown, now: number): FeedWindow[] {
  const all = objects(root);
  const infos = all.flatMap((o) => Array.isArray(o.codingPlanInstanceInfos) ? o.codingPlanInstanceInfos.filter(isRecord) : []);
  const activeScore = (o: Record<string, unknown>) => {
    const status = String(o.status ?? o.instanceStatus ?? "");
    if (/^(ACTIVE|VALID)$/i.test(status)) return 3;
    if (/^(EXPIRED|INVALID|INACTIVE|DISABLED|TERMINATED|STOPPED)$/i.test(status)) return -1;
    if (o.isActive === true || o.active === true) return 3;
    if (o.isActive === false || o.active === false) return -1;
    return ["endTime", "periodEndTime", "expireTime", "expirationTime"].some((k) => (date(o[k]) ?? 0) > now) ? 1 : 0;
  };
  const active = [...infos].sort((a, b) => activeScore(b) - activeScore(a)).find((o) => activeScore(o) > 0);
  const scope = active && infos.length > 1 ? objects(active) : [...(active ? objects(active) : []), ...all];
  const quota = scope.find((o) => ["per5HourTotalQuota", "perFiveHourTotalQuota", "perWeekTotalQuota", "perBillMonthTotalQuota", "perMonthTotalQuota"].some((key) => key in o));
  if (!quota) {
    if (active && typeof (active.planName ?? active.instanceName ?? active.packageName) === "string") return [];
    throw new HttpError(NAME, 200);
  }
  const windows: FeedWindow[] = [];
  for (const [prefixes, minutes] of [[["per5Hour", "perFiveHour"], 300], [["perWeek"], 10080], [["perBillMonth", "perMonth"], 43200]] as const) {
    const total = prefixes.map((p) => finiteNumber(quota[`${p}TotalQuota`])).find((n) => n !== null);
    const used = prefixes.map((p) => finiteNumber(quota[`${p}UsedQuota`])).find((n) => n !== null);
    const reset = prefixes.map((p) => date(quota[`${p}QuotaNextRefreshTime`])).find((n) => n !== null) ?? null;
    if (total !== undefined && total !== null && total > 0 && used !== undefined && used !== null && used >= 0) windows.push(feedWindow(minutes, Math.min(100, used / total * 100), reset, now));
  }
  if (!windows.length && !active) throw new HttpError(NAME, 200);
  return windows.slice(0, 2);
}
export const alibaba: Provider = {
  id: ID, name: NAME,
  async fetch(context) {
    const entry = await providerEntry(context, ID);
    const manualMissing = entry.cookieSource === "manual" && (typeof entry.cookieHeader !== "string" || !entry.cookieHeader.trim());
    const cookie = entry.cookieSource === "off" || manualMissing ? null : await cookieHeader(context, ID, { domains: HOSTS, envNames: ["ALIBABA_CODING_PLAN_COOKIE"] });
    const key = await apiKey(context, ID, ["ALIBABA_CODING_PLAN_API_KEY", "ALIBABA_QWEN_API_KEY", "DASHSCOPE_API_KEY"]);
    if (!cookie && !key) throw new NotConfigured(NAME);
    const regions = entry.region === "cn" ? [true] : [false, true];
    const account = base(context);
    let authRejected = false;
    for (const credential of [cookie ? { cookie } : null, key ? { key } : null]) {
      if (!credential) continue;
      for (const cn of regions) {
        const origin = endpoint(context.env.ALIBABA_CODING_PLAN_HOST, cn ? "https://bailian.console.aliyun.com" : "https://modelstudio.console.alibabacloud.com", HOSTS).origin;
        const region = cn ? "cn-beijing" : "ap-southeast-1";
        const dashboard = `${origin}/${region}/?tab=${cn ? "model" : "coding-plan"}#/efm/coding_plan`;
        const api = "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2";
        const url = endpoint(context.env.ALIBABA_CODING_PLAN_QUOTA_URL,
          `${"cookie" in credential ? (cn ? "https://bailian-cs.console.aliyun.com" : "https://bailian-singapore-cs.alibabacloud.com") : origin}/data/api.json`, HOSTS);
        if (!context.env.ALIBABA_CODING_PLAN_QUOTA_URL) url.search = new URLSearchParams({ action: "cookie" in credential ? (cn ? "BroadScopeAspnGateway" : "IntlBroadScopeAspnGateway") : api, product: "cookie" in credential ? "sfm_bailian" : "broadscope-bailian", api: "cookie" in credential ? api : "queryCodingPlanInstanceInfoV2", ...("cookie" in credential ? { _v: "undefined" } : { currentRegionId: region }) }).toString();
        const query = { commodityCode: cn ? "sfm_codingplan_public_cn" : "sfm_codingplan_public_intl" };
        try {
          let init: RequestInit;
          if ("cookie" in credential && credential.cookie) {
            const token = await secToken(context, origin, dashboard, credential.cookie);
            if (!token) throw new SignIn();
            init = { method: "POST", headers: headers(credential.cookie, origin, dashboard.split("#")[0]), body: new URLSearchParams({ params: JSON.stringify({ Api: api, V: "1.0", Data: { queryCodingPlanInstanceInfoRequest: { ...query, onlyLatestOne: true }, cornerstoneParam: cornerstone(origin, dashboard, cn ? "BAILIAN_ALIYUN" : "MODELSTUDIO_ALIBABACLOUD", credential.cookie) } }), region, sec_token: token }) };
          } else if ("key" in credential && credential.key) {
            init = { method: "POST", headers: { Authorization: `Bearer ${credential.key}`, "x-api-key": credential.key, "X-DashScope-API-Key": credential.key, "Content-Type": "application/json", Accept: "application/json", "User-Agent": UA, Origin: origin, Referer: dashboard }, body: JSON.stringify({ queryCodingPlanInstanceInfoRequest: query }) };
          } else continue;
          const windows = codingWindows(await jsonResponse(await request(context, url, init)), context.now());
          return [{ ...account, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
        } catch (error) {
          if (error instanceof RateLimited) throw error;
          if (error instanceof SignIn) { authRejected = true; continue; }
          if (error instanceof HttpError && !cn) continue;
          throw error;
        }
      }
    }
    if (authRejected) return [{ ...account, error: "sign in" }];
    throw new HttpError(NAME, 200);
  },
};
