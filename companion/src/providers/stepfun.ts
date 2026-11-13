import { accountLabel, feedWindow, finiteNumber, isRecord, type FeedWindow, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { jwtPayload } from "./codex.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const HOST = "https://platform.stepfun.com";
const WEBID = "c8a1002d2c457e758785a9979832217c7c0b884c";
const HEADERS = {
  "content-type": "application/json", "oasis-appid": "10300", "oasis-platform": "web",
  "oasis-webid": WEBID,
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
};
class SignIn extends Error {}
const timestamp = (value: unknown) => { const n = finiteNumber(value); return n !== null && n > 0 ? n : null; };
const percent = (left: number) => Math.max(0, Math.min(100, (1 - left) * 100));

export function parseUsage(body: unknown, now: number): FeedWindow[] {
  if (!isRecord(body)) throw new HttpError("StepFun", 200);
  if (body.status !== 1) {
    if ([401, 403].includes(Number(body.code)) || /unauth|invalid (?:token|credentials)|token expired|expired token/i.test(String(body.message ?? body.desc ?? ""))) throw new SignIn();
    throw new HttpError("StepFun", 200);
  }
  const credit = isRecord(body.plan_credit_rate_limit) ? body.plan_credit_rate_limit : null;
  const fiveReset = timestamp(body.five_hour_usage_reset_time);
  const weekReset = timestamp(body.weekly_usage_reset_time);
  const hasCredit = credit && (credit.subscription_credit_left_rate !== undefined || credit.topup_credit_left_rate !== undefined || (Array.isArray(credit.credit_buckets) && credit.credit_buckets.length > 0));
  if (!fiveReset && !weekReset && (hasCredit || finiteNumber(body.plan_family) === 2)) {
    if (!credit) return [];
    let left = finiteNumber(credit.subscription_credit_left_rate) ?? finiteNumber(credit.topup_credit_left_rate);
    if (Array.isArray(credit.credit_buckets) && credit.credit_buckets.length > 0) {
      let total = 0; let residual = 0; let valid = true;
      for (const bucket of credit.credit_buckets) {
        const t = isRecord(bucket) ? finiteNumber(bucket.credit_total) : null;
        const r = isRecord(bucket) ? finiteNumber(bucket.credit_residual) : null;
        if (t === null || r === null || t <= 0 || r < 0 || r > t) { valid = false; break; }
        total += t; residual += r;
      }
      if (valid && Number.isFinite(total) && Number.isFinite(residual)) left = residual / total;
    }
    return left === null ? [] : [feedWindow(null, percent(left), timestamp(credit.subscription_credit_reset_time), now, "Credit")];
  }
  const five = finiteNumber(body.five_hour_usage_left_rate);
  const week = finiteNumber(body.weekly_usage_left_rate);
  if (five === null || week === null || finiteNumber(body.five_hour_usage_reset_time) === null || finiteNumber(body.weekly_usage_reset_time) === null) throw new HttpError("StepFun", 200);
  return [feedWindow(300, percent(five), fiveReset, now), feedWindow(10080, percent(week), weekReset, now)];
}

function normalize(raw: string): string {
  const clean = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
  return /(?:^|[;\s])Oasis-Token=([^;]+)/.exec(clean)?.[1]?.trim() ?? clean;
}
function webid(token: string): string {
  for (const part of token.split("...").reverse()) {
    const id = jwtPayload(part)?.device_id;
    if (typeof id === "string" && id) return id;
  }
  return WEBID;
}
async function request(context: Context, path: string, init: RequestInit = {}): Promise<Response> {
  const response = await context.fetch(HOST + path, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) throw new SignIn();
  if (response.status === 429) throw new RateLimited("StepFun", context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError("StepFun", response.status);
  return response;
}
async function json(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { throw new HttpError("StepFun", response.status); }
}
function tokenPair(body: unknown): string {
  const access = isRecord(body) && isRecord(body.accessToken) ? body.accessToken.raw : null;
  const refresh = isRecord(body) && isRecord(body.refreshToken) ? body.refreshToken.raw : null;
  if (typeof access !== "string" || !access) throw new HttpError("StepFun", 200);
  return access + (typeof refresh === "string" && refresh ? "..." + refresh : "");
}
/** Tokens from a password login, kept for the run so each poll does not open a new session. */
const sessions = new WeakMap<Context, Map<string, string>>();

async function cachedLogin(context: Context, username: string, password: string): Promise<string> {
  let cache = sessions.get(context);
  if (!cache) {
    cache = new Map();
    sessions.set(context, cache);
  }
  const existing = cache.get(username);
  if (existing) return existing;
  const token = await login(context, username, password);
  cache.set(username, token);
  return token;
}

async function login(context: Context, username: string, password: string): Promise<string> {
  const home = await request(context, "", { headers: HEADERS });
  const ingress = home.headers.getSetCookie().map((c) => /(?:^|\s)INGRESSCOOKIE=([^;]+)/.exec(c)?.[1]).find(Boolean);
  if (!ingress) throw new HttpError("StepFun", home.status);
  const anon = tokenPair(await json(await request(context, "/passport/proto.api.passport.v1.PassportService/RegisterDevice", {
    method: "POST", headers: { ...HEADERS, Cookie: `INGRESSCOOKIE=${ingress}` }, body: "{}",
  })));
  const id = webid(anon);
  return tokenPair(await json(await request(context, "/passport/proto.api.passport.v1.PassportService/SignInByPassword", {
    method: "POST", headers: { ...HEADERS, "oasis-webid": id, Cookie: `Oasis-Token=${anon}; Oasis-Webid=${id}; INGRESSCOOKIE=${ingress}` },
    body: JSON.stringify({ username, password }),
  })));
}

export const stepfun: Provider = {
  id: "stepfun", name: "StepFun",
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, "stepfun");
    if (entry.cookieSource === "off") throw new NotConfigured("StepFun");
    const now = context.now();
    const base = { provider: "stepfun", account: accountLabel(null), blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [] };
    try {
      const settingsToken = typeof entry.region === "string" && entry.region.trim() ? entry.region : null;
      const settingsUser = await apiKey(context, "stepfun", []);
      const settingsPassword = typeof entry.password === "string" ? entry.password : null;
      let token: string | null = null;
      if (settingsToken) {
        token = await cookieHeader({ ...context, env: { STEPFUN_TOKEN: settingsToken } }, "stepfun", { domains: [], envNames: ["STEPFUN_TOKEN"] });
      } else if (entry.cookieSource === "manual") {
        token = await cookieHeader(context, "stepfun", { domains: [], envNames: [] });
      } else if (settingsUser && settingsPassword) {
        base.account = accountLabel(settingsUser);
        token = await cachedLogin(context, settingsUser, settingsPassword);
      } else {
        token = await cookieHeader(context, "stepfun", { domains: [], envNames: ["STEPFUN_TOKEN"] });
        if (!token && context.env.STEPFUN_USERNAME?.trim() && context.env.STEPFUN_PASSWORD?.trim()) {
          base.account = accountLabel(context.env.STEPFUN_USERNAME.trim());
          token = await cachedLogin(context, context.env.STEPFUN_USERNAME.trim(), context.env.STEPFUN_PASSWORD.trim());
        }
      }
      if (!token) throw new NotConfigured("StepFun");
      token = normalize(token);
      if (!token) throw new NotConfigured("StepFun");
      // Do not refresh another tool's token: StepFun returns a replacement token pair.
      const id = webid(token);
      const body = await json(await request(context, "/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit", {
        method: "POST", headers: { ...HEADERS, "oasis-webid": id, Cookie: `Oasis-Token=${token}; Oasis-Webid=${id}` }, body: "{}",
      }));
      const windows = parseUsage(body, now);
      return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
    } catch (error) {
      if (error instanceof SignIn) {
        // A rejected session token is dropped so the next poll logs in again.
        sessions.delete(context);
        return [{ ...base, error: "sign in" }];
      }
      throw error;
    }
  },
};
