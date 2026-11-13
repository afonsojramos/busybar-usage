import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

function percent(snapshot: unknown): number | null {
  if (!isRecord(snapshot) || snapshot.unlimited === true) return null;
  const entitlement = finiteNumber(snapshot.entitlement);
  const remaining = finiteNumber(snapshot.remaining);
  if (entitlement === 0 && remaining === 0) return null;
  const left = finiteNumber(snapshot.percent_remaining) ?? (entitlement !== null && entitlement > 0 && remaining !== null ? remaining / entitlement * 100 : null);
  return left === null ? null : Math.min(100, Math.max(0, 100 - left));
}

export function parseUsage(body: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(body)) return null;
  const reset = isoToSeconds(body.quota_reset_date);
  const snapshots = isRecord(body.quota_snapshots) ? body.quota_snapshots : {};
  const monthly = isRecord(body.monthly_quotas) ? body.monthly_quotas : {};
  const limited = isRecord(body.limited_user_quotas) ? body.limited_user_quotas : {};
  const windows: FeedWindow[] = [];
  const candidates = Object.entries(snapshots).filter(([, v]) => percent(v) !== null || (isRecord(v) && v.unlimited === true));
  const premium = snapshots.premium_interactions ?? candidates.find(([k]) => /premium|completion|code/i.test(k))?.[1];
  const chat = snapshots.chat ?? candidates.find(([k]) => /chat/i.test(k))?.[1] ?? (premium === undefined ? candidates[0]?.[1] : undefined);
  for (const [name, snapshot, key] of [["Premium", premium, "completions"], ["Chat", chat, "chat"]] as const) {
    let used = percent(snapshot);
    const total = finiteNumber(monthly[key]);
    const left = finiteNumber(limited[key]);
    if (used === null && total !== null && total > 0 && left !== null) used = 100 - Math.max(0, Math.min(100, Math.max(0, left) / total * 100));
    if (used !== null) windows.push(feedWindow(null, used, reset, now, name));
  }
  const unlimited = [premium, chat].some((s) => isRecord(s) && s.unlimited === true);
  const credits = (isRecord(premium) ? finiteNumber(premium.credits_used) : null) ?? (isRecord(chat) ? finiteNumber(chat.credits_used) : null);
  if (credits !== null && (credits > 0 || unlimited || body.token_based_billing === true) && windows.length < 2) {
    const value = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(credits);
    windows.push(valueWindow("Credits", `${value} cr`, reset));
  }
  return windows.length || unlimited || body.token_based_billing === true ? windows : null;
}

export const copilot: Provider = {
  id: "copilot",
  name: "Copilot",
  async fetch(context): Promise<FeedAccount[]> {
    const token = await apiKey(context, "copilot", []);
    if (!token) throw new NotConfigured("Copilot");
    const now = context.now();
    const base: FeedAccount = { provider: "copilot", account: accountLabel(null), blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [] };
    const response = await context.fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        Authorization: `token ${token}`, Accept: "application/json", "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7", "User-Agent": "GitHubCopilotChat/0.26.7", "X-Github-Api-Version": "2025-04-01",
      }, signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Copilot", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Copilot", response.status);
    let body: unknown;
    try { body = await response.json(); } catch { throw new HttpError("Copilot", response.status); }
    if (isRecord(body) && body.access_type_sku === "subscription_ended") return [{ ...base, blocked: true, error: "plan ended" }];
    const windows = parseUsage(body, now);
    if (windows === null) throw new HttpError("Copilot", response.status);
    return [{ ...base, account: accountLabel(isRecord(body) && typeof body.email === "string" ? body.email : null), windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
  },
};
