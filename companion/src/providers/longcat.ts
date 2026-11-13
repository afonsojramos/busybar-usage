import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

class SignIn extends Error {}
function count(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^[+-]?(?:nan|inf(?:inity)?)$/i.test(value)) return Number.NaN;
  return finiteNumber(value);
}
const HEADERS = {
  Accept: "application/json, text/plain, */*", Origin: "https://longcat.chat", Referer: "https://longcat.chat/platform/usage",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
};
function normalize(raw: string): string | null {
  const clean = raw.trim().replace(/^(['"])(.*)\1$/, "$2");
  const captured = /(?:-H|--header)\s+(['"])Cookie:\s*([^\r\n]*?)\1/i.exec(clean)?.[2];
  const value = (captured ?? clean.replace(/^Cookie:\s*/i, "")).trim();
  return /^[^;=\s]+=.+/.test(value) && !/[\r\n]/.test(value) && !value.startsWith("curl ") ? value : null;
}
async function request(context: Context, cookie: string, path: string, post = false): Promise<Record<string, unknown>> {
  const response = await context.fetch("https://longcat.chat" + path, {
    headers: { ...HEADERS, Cookie: cookie, ...(post ? { "Content-Type": "application/json" } : {}) },
    ...(post ? { method: "POST", body: "{}" } : {}), redirect: "manual", signal: AbortSignal.timeout(30_000),
  });
  if ([401, 403].includes(response.status) || (response.status >= 300 && response.status < 400)) throw new SignIn();
  if (response.status === 429) throw new RateLimited("LongCat", context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError("LongCat", response.status);
  let body: unknown;
  try { body = await response.json(); } catch { throw new HttpError("LongCat", response.status); }
  if (!isRecord(body)) throw new HttpError("LongCat", response.status);
  if ("code" in body) {
    const code = finiteNumber(body.code);
    if (code === null || !Number.isSafeInteger(code)) throw new HttpError("LongCat", response.status);
    if (code === 401 || code === 403) throw new SignIn();
    if (code !== 0 && code !== 200) throw new HttpError("LongCat", response.status);
  }
  const data = "data" in body ? body.data : body;
  if (!isRecord(data)) throw new HttpError("LongCat", response.status);
  return data;
}
async function optional(context: Context, cookie: string, path: string, post = false) {
  try { return await request(context, cookie, path, post); }
  catch (error) { if (error instanceof RateLimited || (error instanceof Error && error.name === "AbortError")) throw error; return null; }
}
function expiry(value: unknown): number | null {
  const n = finiteNumber(value);
  if (n !== null && n > 1e9) {
    const ms = n > 1e12 ? n : n * 1000;
    return Number.isFinite(new Date(ms).getTime()) ? Math.floor(ms / 1000) : null;
  }
  return isoToSeconds(value);
}
export const longcat: Provider = {
  id: "longcat", name: "LongCat",
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, "longcat");
    if (entry.cookieSource === "off") throw new NotConfigured("LongCat");
    const raw = await cookieHeader(context, "longcat", {
      domains: ["longcat.chat", "www.longcat.chat"], envNames: ["LONGCAT_MANUAL_COOKIE", "longcat_manual_cookie"],
    });
    const cookie = raw ? normalize(raw) : null;
    if (!cookie) throw new NotConfigured("LongCat");
    const now = context.now();
    const base = { provider: "longcat", account: accountLabel(null), blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [] };
    try {
      const account = await request(context, cookie, "/api/v1/user-current");
      const summary = await optional(context, cookie, "/api/pay/quota/metering/token-packs/summary", true);
      const lot = summary && isRecord(summary.currentLot) ? summary.currentLot : null;
      let total: number; let used: number;
      const lotTotal = count(lot?.totalToken);
      if (typeof lot?.status === "string" && lot.status.toUpperCase() === "ACTIVE" && lotTotal !== null && lotTotal > 0) {
        total = lotTotal; used = count(lot.consumedToken) ?? 0;
      } else {
        const payload = await request(context, cookie, "/api/lc-platform/v1/tokenUsage");
        const usage = isRecord(payload.usage) ? payload.usage : payload;
        const parsedTotal = count(usage.totalToken);
        if (parsedTotal === null) throw new HttpError("LongCat", 200);
        total = parsedTotal;
        used = count(usage.usedToken) ?? total - (count(usage.availableToken) ?? total);
      }
      const fuel = await optional(context, cookie, "/api/lc-platform/v1/pending-fuel-packages");
      const fuelTotal = count(fuel?.totalQuota);
      let remaining = 0; let sawRemaining = false; let reset: number | null = null;
      for (const pack of Array.isArray(fuel?.list) ? fuel.list : []) {
        if (!isRecord(pack)) continue;
        const available = count(pack.availableToken);
        if (available !== null) { remaining += available; sawRemaining = true; }
        const date = expiry(pack.expireTime);
        if (date !== null && (reset === null || date < reset)) reset = date;
      }
      if (!sawRemaining) remaining = fuelTotal ?? 0;
      const windows: FeedWindow[] = [];
      if (total > 0 && Number.isFinite(total) && Number.isFinite(used)) windows.push(feedWindow(null, Math.min(100, Math.max(0, used) / total * 100), null, now, "Tokens"));
      const fuelUsed = Math.max(0, (fuelTotal ?? 0) - remaining);
      if (fuelTotal !== null && fuelTotal > 0 && Number.isFinite(fuelTotal) && Number.isFinite(remaining) && Number.isFinite(fuelUsed)) windows.push(feedWindow(null, Math.min(100, fuelUsed / fuelTotal * 100), reset, now, "Fuel"));
      return [{ ...base, account: accountLabel(typeof account.email === "string" ? account.email : null), windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
    } catch (error) { if (error instanceof SignIn) return [{ ...base, error: "sign in" }]; throw error; }
  },
};
