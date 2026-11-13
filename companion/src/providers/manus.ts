import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedWindow } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const URL = "https://api.manus.im/user.v1.UserService/GetAvailableCredits";
const CREDIT_KEYS = ["totalCredits", "freeCredits", "periodicCredits", "addonCredits", "refreshCredits",
  "maxRefreshCredits", "proMonthlyCredits", "eventCredits"];

function sessionToken(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const match = /(?:^|;)\s*session_id\s*=\s*([^;]+)/i.exec(raw.replace(/^cookie:\s*/i, ""));
  return match?.[1].trim() || (!/[=;]/.test(raw) ? raw.trim() : null);
}

function parseCredits(root: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(root)) return null;
  const data = root.data ?? root.result ?? root.response ?? root.availableCredits ?? root;
  if (!isRecord(data) || !CREDIT_KEYS.some((key) => Object.hasOwn(data, key))) return null;
  const number = (key: string) => finiteNumber(data[key]) ?? 0;
  const monthly = number("proMonthlyCredits");
  const refresh = number("maxRefreshCredits");
  const windows: FeedWindow[] = [];
  // Numeric Manus dates use Foundation's 2001 epoch, including zero.
  const reset = typeof data.nextRefreshTime === "number" && Number.isFinite(data.nextRefreshTime)
    ? data.nextRefreshTime + 978307200 : isoToSeconds(data.nextRefreshTime);
  if (refresh > 0) windows.push(feedWindow(
    typeof data.refreshInterval === "string" && /^daily(?: refresh)?$/i.test(data.refreshInterval) ? 1440 : null,
    Math.min(100, (refresh - number("refreshCredits")) / refresh * 100), reset, now, "refresh"));
  if (monthly > 0) windows.push(feedWindow(43200,
    Math.min(100, (monthly - number("periodicCredits")) / monthly * 100), null, now));
  if (windows.length < 2 && Object.hasOwn(data, "totalCredits")) {
    const balance = number("totalCredits");
    const formatted = Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(balance);
    windows.push(valueWindow("balance", `${formatted} cr`.slice(0, 12)));
  }
  return windows;
}

export const manus: Provider = {
  id: "manus", name: "Manus",
  async fetch(context) {
    const entry = await providerEntry(context, "manus");
    if (entry.cookieSource === "off" || (entry.cookieSource === "manual" &&
      (typeof entry.cookieHeader !== "string" || !entry.cookieHeader.trim()))) throw new NotConfigured("Manus");
    const cookie = await cookieHeader(context, "manus", { domains: ["manus.im"], required: ["session_id"] });
    const tokenNames = ["MANUS_SESSION_TOKEN", "manus_session_token", "MANUS_SESSION_ID", "manus_session_id"];
    const cookieNames = ["MANUS_COOKIE", "manus_cookie"];
    const environmentToken = async (envNames: string[]) => {
      if (!envNames.some((name) => context.env[name]?.trim())) return null;
      return sessionToken(await cookieHeader(context, "manus", {
        domains: ["manus.im"], required: ["session_id"], envNames,
      }));
    };
    const fallback = entry.cookieSource === "manual" ? null
      : await environmentToken(tokenNames) ?? await environmentToken(cookieNames);
    const tokens = [sessionToken(cookie), ...(entry.cookieSource === "manual" ? [] : [fallback])]
      .filter((token): token is string => token !== null);
    if (!tokens.length) throw new NotConfigured("Manus");
    const now = context.now();
    const base = { provider: "manus", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [] };
    for (const token of new Set(tokens)) {
      const response = await context.fetch(URL, {
        method: "POST", body: "{}", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          Origin: "https://manus.im", Referer: "https://manus.im/", "Connect-Protocol-Version": "1",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36" },
      });
      if (response.status === 401 || response.status === 403) continue;
      if (response.status === 429) throw new RateLimited("Manus", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Manus", response.status);
      let body: unknown;
      try { body = await response.json(); } catch { throw new HttpError("Manus", response.status); }
      const windows = parseCredits(body, now);
      if (windows === null) throw new HttpError("Manus", response.status);
      return [{ ...base, windows, blocked: windows.some((window) => (window.used_percent ?? 0) >= 100) }];
    }
    return [{ ...base, error: "sign in" }];
  },
};
