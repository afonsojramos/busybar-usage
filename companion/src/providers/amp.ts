import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";
function money(value: number): string {
  return Math.abs(value) < 1e8 ? `$${value.toFixed(2)}` : `$${value.toExponential(2)}`;
}


const number = (text: string | undefined) => finiteNumber(text?.replaceAll(",", ""));

export function parseAmpUsage(raw: string, now: number): { email: string | null; windows: FeedWindow[] } | null {
  const text = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replaceAll("**", "");
  const windows: FeedWindow[] = [];
  const amount = "([0-9][0-9,]*(?:\\.[0-9]+)?)";
  const free = text.match(new RegExp(`^\\s*Amp Free:\\s*\\$?${amount}\\s*/\\s*\\$?${amount}\\s+remaining(?:\\s*\\(replenishes\\s*\\+\\$?${amount}\\s*/\\s*hour\\))?`, "im"));
  const percent = text.match(new RegExp(`^\\s*Amp Free:\\s*${amount}\\s*%\\s+remaining(?:\\s+today)?`, "im"));
  if (free) {
    const remaining = number(free[1]); const quota = number(free[2]); const hourly = number(free[3]);
    if (remaining !== null && quota !== null && quota > 0) {
      const minutes = hourly !== null && hourly > 0 ? Math.max(1, Math.round(quota / hourly)) * 60 : null;
      const reset = hourly !== null && hourly > 0 ? now + Math.max(0, quota - remaining) / hourly * 3600 : null;
      windows.push(feedWindow(minutes, Math.max(0, quota - remaining) / quota * 100, reset, now, minutes === null ? "free" : undefined));
    }
  } else if (percent) {
    // Amp's daily boundary is 20:00 in New York, including daylight-saving transitions.
    const zone = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = zone.formatToParts(new Date(now * 1000));
    const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === name)?.value);
    const nominal = Date.UTC(part("year"), part("month") - 1, part("day"), 20) / 1000;
    const offsetAt = (t: number) => {
      const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "longOffset" })
        .formatToParts(new Date(t * 1000)).find(p => p.type === "timeZoneName")?.value.match(/GMT([+-])(\d{2}):(\d{2})/);
      return time ? (time[1] === "+" ? 1 : -1) * (Number(time[2]) * 3600 + Number(time[3]) * 60) : 0;
    };
    let reset = nominal - offsetAt(nominal);
    if (reset <= now) { const tomorrow = nominal + 86400; reset = tomorrow - offsetAt(tomorrow); }
    windows.push(feedWindow(1440, 100 - Math.min(100, number(percent[1]) ?? 0), reset, now));
  }
  const tier = text.match(new RegExp(`^\\s*Amp\\s+[^\\r\\n]+?\\s+Tier:\\s*agent\\s+usage\\s+\\$${amount}\\s+of\\s+\\$${amount}\\s+remaining([^\\r\\n]*?)resets\\s+upon\\s+renewal\\s+in\\s+(\\d+)\\s+(days?|months?)`, "im"));
  const legacy = text.match(/^\s*(?:Subscription\s+.+?|Amp\s+.+?\s+Subscription):\s*([\d.]+)%\s+other\s+usage\s+and\s+([\d.]+)%\s+orb\s+usage\s+remaining\s*-\s*resets\s+upon\s+renewal\s+in\s+(\d+)\s+(days?|months?)/im);
  if (tier || legacy) {
    const data = tier ?? legacy!;
    const renewal = Number(data[tier ? 4 : 3]);
    const unit = data[tier ? 5 : 4];
    const end = new Date(now * 1000);
    if (unit.startsWith("month")) end.setMonth(end.getMonth() + renewal);
    else end.setDate(end.getDate() + renewal);
    const period = tier?.[3].match(/period\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/);
    const start = period ? isoToSeconds(`${period[1]}T00:00:00Z`) : null;
    const finish = period ? isoToSeconds(`${period[2]}T00:00:00Z`) : null;
    const minutes = start !== null && finish !== null && finish > start ? (finish - start) / 60 : 43200;
    const reset = finish ?? end.getTime() / 1000;
    const limit = tier ? number(tier[2]) : null;
    const remaining = number(data[1]);
    if (remaining !== null && (!tier || (limit !== null && limit > 0))) {
      windows.push(feedWindow(minutes, tier ? Math.max(0, (limit! - remaining) / limit! * 100) : 100 - Math.min(100, remaining), reset, now));
    }
    const orb = tier?.[3].match(new RegExp(`orb\\s+usage\\s+${amount}h\\s+of\\s+${amount}h\\s+a1\\.small\\s+orb\\s+hours\\s+remaining`, "i"));
    if (tier && orb && (number(orb[2]) ?? 0) > 0) windows.push(feedWindow(minutes,
      Math.max(0, (1 - number(orb[1])! / number(orb[2])!) * 100), reset, now));
    else if (legacy) windows.push(feedWindow(43200, 100 - Math.min(100, Number(legacy[2])), reset, now));
  }
  const credits = number(text.match(new RegExp(`^\\s*Individual credits:\\s*\\$?${amount}\\s+remaining`, "im"))?.[1]);
  if (credits !== null) windows.push(valueWindow("credits", money(credits)));
  for (const match of text.matchAll(new RegExp(`^\\s*Workspace\\s+(.+?):\\s*\\$?${amount}\\s+remaining`, "gim"))) {
    const value = number(match[2]);
    if (value !== null) windows.push(valueWindow("workspace", money(value)));
  }
  if (!windows.length) return null;
  const sorted = windows.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  return { email: text.match(/^\s*Signed in as\s+([^\s(]+)/im)?.[1] ?? null, windows: sorted };
}

function webUsage(text: string, now: number): FeedWindow[] | null {
  for (const token of ["freeTierUsage", "getFreeTierUsage"]) {
    const start = text.indexOf(token);
    if (start < 0) continue;
    const object = text.slice(start).match(/\{([^}]+)\}/)?.[1];
    if (!object) continue;
    const field = (key: string) => number(object.match(new RegExp(`\\b${key}\\s*:\\s*([\\d.]+)`))?.[1]);
    const quota = field("quota"); const used = field("used"); const hourly = field("hourlyReplenishment");
    if (quota === null || quota <= 0 || used === null || hourly === null) continue;
    const hours = field("windowHours");
    return [feedWindow(hours === null ? null : hours * 60, used / quota * 100,
      hourly > 0 ? now + used / hourly * 3600 : null, now, hours === null ? "free" : undefined)];
  }
  return null;
}

export const amp: Provider = {
  id: "amp", name: "Amp",
  async fetch(context) {
    const now = context.now();
    const base: FeedAccount = { provider: "amp", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [] };
    const finish = (windows: FeedWindow[], email: string | null) => [{ ...base, account: accountLabel(email),
      windows: windows.slice(0, 2), blocked: windows.some(w => (w.used_percent ?? 0) >= 100) }];
    const cli = await context.run("amp", ["usage"], { timeoutMs: 15_000, env: { NO_COLOR: "1" } });
    if (cli?.code === 0) {
      const parsed = parseAmpUsage(cli.stdout.trim() ? cli.stdout : cli.stderr, now);
      if (parsed) return finish(parsed.windows, parsed.email);
    }
    const token = await apiKey(context, "amp", ["AMP_API_KEY"]);
    const cookie = token ? null : await cookieHeader(context, "amp", { domains: ["ampcode.com", "www.ampcode.com"], required: ["session"] });
    if (!token && !cookie) {
      if (cli && /sign in|log in|login/i.test(cli.stdout + cli.stderr)) return [{ ...base, error: "sign in" }];
      if (cli) throw new HttpError("Amp", 502);
      throw new NotConfigured("Amp");
    }
    const response = await context.fetch(token ? "https://ampcode.com/api/internal?userDisplayBalanceInfo" : "https://ampcode.com/settings", {
      method: token ? "POST" : "GET", headers: token ? { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" }
        : { Cookie: cookie!, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", Origin: "https://ampcode.com", Referer: "https://ampcode.com/settings",
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" },
      ...(token ? { body: JSON.stringify({ method: "userDisplayBalanceInfo", params: {} }) } : {}),
      signal: AbortSignal.timeout(30_000), redirect: "manual",
    });
    if ([401, 403].includes(response.status)) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Amp", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Amp", response.status);
    if (token) {
      let data: unknown;
      try { data = await response.json(); } catch { throw new HttpError("Amp", response.status); }
      if (isRecord(data) && data.ok === false && isRecord(data.error) && data.error.code === "auth-required") return [{ ...base, error: "sign in" }];
      if (!isRecord(data) || data.ok !== true || !isRecord(data.result) || typeof data.result.displayText !== "string") throw new HttpError("Amp", response.status);
      const parsed = parseAmpUsage(data.result.displayText, now);
      if (!parsed) throw new HttpError("Amp", response.status);
      return finish(parsed.windows, parsed.email);
    }
    const text = await response.text();
    const windows = webUsage(text, now);
    if (!windows) {
      if (/sign in|log in|login/i.test(text)) return [{ ...base, error: "sign in" }];
      throw new HttpError("Amp", response.status);
    }
    return finish(windows, null);
  },
};
