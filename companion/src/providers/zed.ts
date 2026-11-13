import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedWindow } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";
function money(value: number): string {
  return Math.abs(value) < 1e8 ? `$${value.toFixed(2)}` : `$${value.toExponential(2)}`;
}


export const zed: Provider = {
  id: "zed", name: "Zed",
  async fetch(context) {
    const now = context.now();
    const entry = await providerEntry(context, "zed");
    const browser = entry.cookieSource === "manual" || entry.cookieSource === "auto" || typeof entry.cookieHeader === "string";
    const cookie = browser ? await cookieHeader(context, "zed", { domains: ["zed.dev"], required: ["zed.session"] }) : null;
    let url = "https://cloud.zed.dev/frontend/billing/usage";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (browser) {
      if (!cookie) throw new NotConfigured("Zed");
      headers.Cookie = cookie;
    } else {
      let settings: unknown = null;
      const raw = await context.readFile(join(context.home, ".config/zed/settings.json"));
      if (raw) { try { settings = JSON.parse(raw); } catch { throw new NotConfigured("Zed"); } }
      const server = isRecord(settings) && typeof settings.server_url === "string" ? settings.server_url.trim() : "https://zed.dev";
      const service = isRecord(settings) && typeof settings.credentials_url === "string" ? settings.credentials_url.trim() : server;
      const trusted = server === "https://zed.dev" || server === "https://staging.zed.dev";
      let endpoint: URL;
      try { endpoint = new URL(trusted ? "https://cloud.zed.dev" : server); } catch { throw new NotConfigured("Zed"); }
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || (!trusted && service !== server)) throw new NotConfigured("Zed");
      // Context exposes only the Keychain secret; the user ID attribute must be supplied separately.
      const userID = entry.accountID;
      if (typeof userID !== "string" || !/^\d+$/.test(userID)) throw new NotConfigured("Zed");
      const token = await context.readKeychain(service, userID);
      if (!token) throw new NotConfigured("Zed");
      headers.Authorization = `${userID} ${token}`;
      url = `${endpoint.href.replace(/\/$/, "")}/client/users/me`;
    }
    const base = { provider: "zed", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [] };
    const response = await context.fetch(url, { headers, signal: AbortSignal.timeout(30_000), redirect: "error" });
    if ([401, 403].includes(response.status)) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Zed", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Zed", response.status);
    const fail = (): never => { throw new HttpError("Zed", response.status); };
    let root: unknown;
    try { root = await response.json(); } catch { return fail(); }
    if (!isRecord(root)) return fail();
    const plan = browser ? null : root.plan;
    const usage = browser ? root.current_usage : isRecord(plan) ? plan.usage : null;
    if (!isRecord(usage) || !isRecord(usage.edit_predictions)) return fail();
    const prediction = usage.edit_predictions;
    const used = finiteNumber(prediction.used);
    const rawLimit = prediction.limit;
    const unlimited = rawLimit === "unlimited" || (browser && rawLimit === null);
    const limit = unlimited ? null : finiteNumber(isRecord(rawLimit) ? rawLimit.limited : rawLimit);
    if (used === null || !Number.isSafeInteger(used) || used < 0 || (!unlimited && (limit === null || limit < 0 || !Number.isSafeInteger(limit)))) return fail();
    const period = isRecord(plan) && isRecord(plan.subscription_period) ? plan.subscription_period : null;
    const reset = isoToSeconds(period?.ended_at);
    const start = isoToSeconds(period?.started_at);
    const minutes = reset !== null && start !== null && reset > start ? (reset - start) / 60 : null;
    const windows: FeedWindow[] = [];
    if (unlimited) windows.push(valueWindow("edits", "unlimited"));
    else if (limit !== null && limit > 0) windows.push(feedWindow(minutes, used / limit * 100, reset, now, minutes === null ? "edits" : undefined));
    if (browser) {
      const spend = usage.token_spend;
      if (!isRecord(spend)) return fail();
      const spent = finiteNumber(spend.spend_in_cents);
      const cap = spend.limit_in_cents == null ? null : finiteNumber(spend.limit_in_cents);
      if (spent === null || spent < 0 || (spend.limit_in_cents != null && (cap === null || cap < 0))) return fail();
      if (cap !== null && cap > 0) windows.push(feedWindow(null, spent / cap * 100, null, now, "spend"));
      else windows.push(valueWindow("spent", money(spent / 100)));
    }
    const user = isRecord(root.user) ? root.user : null;
    return [{ ...base, account: accountLabel(typeof user?.email === "string" ? user.email : null), windows,
      blocked: (isRecord(plan) && plan.has_overdue_invoices === true) || windows.some(w => (w.used_percent ?? 0) >= 100) }];
  },
};
