import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

function object(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try { const parsed: unknown = JSON.parse(text); return isRecord(parsed) ? parsed : null; } catch { return null; }
}

async function apiIdentity(context: Context) {
  const expand = (s: string) => s.startsWith("~/") ? join(context.home, s.slice(2)) : s;
  const directory = context.env.KIRO_DATA_DIR ? expand(context.env.KIRO_DATA_DIR)
    : context.platform === "darwin" ? join(context.home, "Library/Application Support/kiro-cli")
      : join(context.env.XDG_DATA_HOME ? expand(context.env.XDG_DATA_HOME) : join(context.home, ".local/share"), "kiro-cli");
  const path = join(directory, "data.sqlite3");
  try {
    const tokens = await context.querySqlite(path, "SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'");
    const token = object(tokens?.[0]?.value)?.access_token;
    if (typeof token !== "string" || !token.trim()) return null;
    const profiles = await context.querySqlite(path, "SELECT value FROM state WHERE key = 'api.codewhisperer.profile'");
    if (profiles === null) return null;
    const arn = profiles.length ? object(profiles[0]?.value)?.arn : null;
    let url = "https://codewhisperer.us-east-1.amazonaws.com/";
    if (profiles.length) {
      if (typeof arn !== "string" || /\s/.test(arn)) return null;
      const parts = arn.split(":");
      if (parts.length !== 6 || parts[0] !== "arn" || parts[1] !== "aws" || parts[2] !== "codewhisperer"
        || !/^profile\/.+/.test(parts[5])) return null;
      if (parts[3] === "eu-central-1") url = "https://q.eu-central-1.amazonaws.com/";
      else if (parts[3] !== "us-east-1") return null;
    }
    return { token, url, body: arn ? { profileArn: arn } : {} };
  } catch { return null; }
}

export function parseKiroUsage(json: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(json) || !Array.isArray(json.usageBreakdownList)) return null;
  const credits = json.usageBreakdownList.filter(isRecord).filter(row => row.resourceType === "CREDIT");
  if (credits.length !== 1) return null;
  const credit = credits[0];
  const limit = finiteNumber(credit.usageLimitWithPrecision);
  const total = finiteNumber(credit.currentUsageWithPrecision);
  const over = finiteNumber(credit.currentOveragesWithPrecision ?? 0);
  const reset = finiteNumber(credit.nextDateReset ?? json.nextDateReset);
  if (limit === null || limit <= 0 || total === null || total < 0 || over === null || over < 0 || over > total
    || reset === null || reset < 1e9 || reset > 4102444800 || total - over > limit
    || (Array.isArray(credit.bonuses) && credit.bonuses.length > 0)) return null;
  // Total usage includes overage; subtract it to avoid charging both gauges for the same credits.
  const windows = [feedWindow(43200, (total - over) / limit * 100, reset, now)];
  const config = json.overageConfiguration;
  const cap = finiteNumber(credit.overageCapWithPrecision);
  if (isRecord(config) && typeof config.overageStatus === "string" && config.overageStatus.toUpperCase() === "ENABLED"
    && cap !== null && cap > 0) windows.push(feedWindow(null, over / cap * 100, reset, now, "overage"));
  return windows;
}

function cliWindows(text: string, now: number): FeedWindow[] | null {
  const covered = text.match(/\(([\d.]+) of ([\d.]+) covered in plan\)/);
  const percent = finiteNumber(text.match(/([\d.]+)%/)?.[1]);
  const used = covered ? finiteNumber(covered[1]) : null;
  const total = covered ? finiteNumber(covered[2]) : null;
  const value = total !== null && total > 0 && used !== null ? used / total * 100 : percent;
  if (value === null) return /Plan:|KIRO [A-Z+]+/.test(text) ? [] : null;
  const date = text.match(/resets on (\d{4}-\d{2}-\d{2}|\d{2}\/\d{2})/)?.[1];
  let reset: number | null = null;
  if (date) {
    if (date.includes("-")) reset = Date.parse(`${date}T00:00:00`) / 1000;
    else {
      let year = new Date(now * 1000).getFullYear();
      reset = Date.parse(`${year}-${date.replace("/", "-")}T00:00:00`) / 1000;
      if (reset <= now) reset = Date.parse(`${++year}-${date.replace("/", "-")}T00:00:00`) / 1000;
    }
    if (!Number.isFinite(reset)) reset = null;
  }
  const windows = [feedWindow(43200, value, reset, now)];
  const bonus = text.match(/Bonus credits:\s*([\d.]+)\/([\d.]+)/);
  if (bonus && Number(bonus[2]) > 0) {
    const days = finiteNumber(text.match(/expires in (\d+) days?/)?.[1]);
    windows.push(feedWindow(null, Number(bonus[1]) / Number(bonus[2]) * 100,
      days === null ? null : now + days * 86400, now, "bonus"));
  }
  return windows;
}

export const kiro: Provider = {
  id: "kiro", name: "Kiro",
  // Runs the provider's CLI, which is slow; CodexBar refreshes about this often.
  minIntervalSeconds: 300,
  async fetch(context) {
    const now = context.now();
    const who = await context.run("kiro-cli", ["whoami"], { timeoutMs: 5_000 });
    const loginRequired = (s: string) => /not logged in|login required|failed to initialize auth portal|kiro-cli login|oauth error/i.test(s);
    const whoText = who?.code === 0 ? who.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") : "";
    const email = whoText.match(/(?:email:\s*|^)([^\s]+@[^\s]+)/im)?.[1];
    const base: FeedAccount = { provider: "kiro", account: accountLabel(email), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [] };
    if (who && loginRequired(who.stdout + who.stderr)) return [{ ...base, error: "sign in" }];
    const identity = await apiIdentity(context);
    let apiError: unknown;
    if (identity) {
      const response = await context.fetch(identity.url, { method: "POST", headers: {
        Authorization: `Bearer ${identity.token}`, "Content-Type": "application/x-amz-json-1.0",
        "X-Amz-Target": "AmazonCodeWhispererService.GetUsageLimits",
      }, body: JSON.stringify(identity.body), signal: AbortSignal.timeout(30_000), redirect: "error" });
      if ([401, 403].includes(response.status)) return [{ ...base, error: "sign in" }];
      if (response.status === 429) throw new RateLimited("Kiro", now + retryAfterSeconds(response.headers, 300));
      if (response.ok) {
        let parsed: unknown;
        try { parsed = await response.json(); } catch { parsed = null; }
        const windows = parseKiroUsage(parsed, now);
        if (windows) return [{ ...base, windows, blocked: windows.some(w => (w.used_percent ?? 0) >= 100) }];
      }
      apiError = new HttpError("Kiro", response.status);
    }
    const args = ["chat", "--no-interactive", "/usage"];
    let result = await context.run("kiro-cli", [...args, "--v2"], { timeoutMs: 20_000 });
    if (result && result.code !== 0 && /error: (?:unexpected argument|unrecognized option|unknown option) ['"]?--v2/.test(result.stdout + result.stderr)) {
      result = await context.run("kiro-cli", args, { timeoutMs: 20_000 });
    }
    if (!result) { if (apiError) throw apiError; throw new NotConfigured("Kiro"); }
    const text = (result.stdout + "\n" + result.stderr).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    if (loginRequired(text)) return [{ ...base, error: "sign in" }];
    const windows = result.code === 0 ? cliWindows(text, now) : null;
    if (!windows) throw apiError ?? new HttpError("Kiro", 502);
    return [{ ...base, windows, blocked: windows.some(w => (w.used_percent ?? 0) >= 100) }];
  },
};
