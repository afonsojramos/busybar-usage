import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { jwtPayload } from "./codex.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const NAME = "Cursor";
const ORIGIN = "https://cursor.com";
const QUERY = "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;";

function json(text: string | null): unknown {
  try { return text === null ? null : JSON.parse(text); } catch { return null; }
}

function appCookie(token: string, now: number): string | null {
  const payload = jwtPayload(token);
  const subject = typeof payload?.sub === "string" ? payload.sub.split("|").at(-1) : null;
  const expiry = finiteNumber(payload?.exp);
  if (!subject || !/^[\w.-]+$/.test(subject) || expiry === null || expiry <= now + 60) return null;
  return `WorkosCursorSessionToken=${subject}%3A%3A${token}`;
}

function sqliteText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!(value instanceof Uint8Array)) return null;
  const buffer = Buffer.from(value);
  return buffer.length > 1 && buffer[1] === 0 ? buffer.toString("utf16le") : buffer.toString("utf8");
}

async function localCookie(context: Context): Promise<string | null> {
  const config = context.env.XDG_CONFIG_HOME && isAbsolute(context.env.XDG_CONFIG_HOME)
    ? context.env.XDG_CONFIG_HOME : join(context.home, ".config");
  const db = context.platform === "darwin"
    ? join(context.home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb")
    : join(config, "Cursor/User/globalStorage/state.vscdb");
  const rows = await context.querySqlite(db, QUERY);
  let token = sqliteText(rows?.[0]?.value);
  if (token?.startsWith("cursor-safe-storage:v1:") && context.platform === "darwin") {
    const bytes = Buffer.from(token.slice("cursor-safe-storage:v1:".length), "base64");
    token = null;
    if (bytes.subarray(0, 3).toString() === "v10" && bytes.length > 3 && (bytes.length - 3) % 16 === 0) {
      for (const account of ["Cursor Key", "Cursor"]) {
        const password = await context.readKeychain("Cursor Safe Storage", account);
        if (!password) continue;
        try {
          const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
          const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
          token = Buffer.concat([decipher.update(bytes.subarray(3)), decipher.final()]).toString("utf8");
          break;
        } catch { /* An old Keychain account can hold a different Safe Storage password. */ }
      }
    }
  }
  return token ? appCookie(token, context.now()) : null;
}

async function storedCookie(context: Context): Promise<string | null> {
  const path = context.platform === "darwin"
    ? join(context.home, "Library/Application Support/CodexBar/cursor-session.json")
    : join(context.env.XDG_DATA_HOME || join(context.home, ".local/share"), "CodexBar/cursor-session.json");
  const data = json(await context.readFile(path));
  if (!Array.isArray(data)) return null;
  const pairs: string[] = [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    const name = item.Name ?? item.name;
    const value = item.Value ?? item.value;
    const domain = item.Domain ?? item.domain;
    const expires = item.Expires ?? item.expires;
    if (typeof domain === "string" && !["cursor.com", "www.cursor.com", "cursor.sh", "authenticator.cursor.sh"].includes(domain.replace(/^\./, ""))) continue;
    if (typeof expires === "number" && expires <= context.now()) continue;
    if (typeof expires === "string" && (isoToSeconds(expires) ?? Infinity) <= context.now()) continue;
    if (typeof name === "string" && typeof value === "string" && !/[\r\n;]/.test(name + value)) pairs.push(`${name}=${value}`);
  }
  return pairs.length ? pairs.join("; ") : null;
}

function ratio(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const used = finiteNumber(value.used);
  const limit = finiteNumber(value.limit);
  return used !== null && limit !== null && limit > 0 ? Math.min(100, 100 * used / limit) : null;
}

async function request(context: Context, cookie: string, path: string, post = false, body: unknown = {}): Promise<unknown> {
  const response = await context.fetch(ORIGIN + path, {
    method: post ? "POST" : "GET",
    headers: { Cookie: cookie, Accept: "application/json", ...(post ? { "Content-Type": "application/json", Origin: ORIGIN } : {}) },
    ...(post ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000), redirect: "error",
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try { return await response.json(); } catch { throw new HttpError(NAME, response.status); }
}

async function teamBudget(context: Context, cookie: string, email: string): Promise<number | null> {
  const teams = await request(context, cookie, "/api/dashboard/teams", true);
  if (!isRecord(teams) || !Array.isArray(teams.teams)) return null;
  const ids = teams.teams.map(team => isRecord(team) ? finiteNumber(team.id) : null);
  if (ids.some(id => id === null || id <= 0) || new Set(ids).size !== ids.length) return null;
  let selected: number | null = ids.length === 1 ? ids[0] : null;
  for (const name of ["portal-selected-team-id", "team_id"]) {
    const matches = cookie.split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
    if (!matches.length) continue;
    if (matches.length !== 1) return null;
    selected = finiteNumber(matches[0].slice(name.length + 1));
    if (!ids.includes(selected)) return null;
    break;
  }
  if (selected === null) return null;
  let count: number | null = null;
  let result: number | null = null;
  for (let page = 1; page <= 20; page++) {
    const data = await request(context, cookie, "/api/dashboard/get-team-spend", true,
      { teamId: selected, page, pageSize: 50, sortBy: "name", sortDirection: "asc" });
    if (!isRecord(data) || !Array.isArray(data.teamMemberSpend)) return null;
    const pages = finiteNumber(data.totalPages);
    if (pages === null || !Number.isInteger(pages) || pages < 1 || pages > 20 || (count !== null && pages !== count)
      || data.teamMemberSpend.length === 0 || data.teamMemberSpend.length > 50 || (page < pages && data.teamMemberSpend.length !== 50)) return null;
    count = pages;
    for (const member of data.teamMemberSpend) {
      if (!isRecord(member) || typeof member.email !== "string" || member.email.trim().toLowerCase() !== email.trim().toLowerCase()) continue;
      const used = finiteNumber(member.overallSpendCents);
      const limit = finiteNumber(member.effectivePerUserLimitDollars ?? member.monthlyLimitDollars);
      if (result !== null || used === null || used < 0 || limit === null || limit <= 0) return null;
      result = used / 100 / limit * 100;
    }
    if (page === pages) return result;
  }
  return null;
}

async function usage(context: Context, cookie: string): Promise<FeedAccount> {
  const summary = await request(context, cookie, "/api/usage-summary");
  if (!isRecord(summary) || (!isRecord(summary.individualUsage) && !isRecord(summary.teamUsage) && typeof summary.membershipType !== "string")) throw new HttpError(NAME, 200);
  const optional = async (path: string, post = false): Promise<unknown> => {
    try { return await request(context, cookie, path, post); } catch { return null; }
  };
  const user = await optional("/api/auth/me");
  const sand = await optional("/api/dashboard/get-sand-usage-status", true);
  const individual = isRecord(summary.individualUsage) ? summary.individualUsage : {};
  const team = isRecord(summary.teamUsage) ? summary.teamUsage : {};
  const plan = isRecord(individual.plan) ? individual.plan : {};
  const end = isoToSeconds(summary.billingCycleEnd);
  const start = isoToSeconds(summary.billingCycleStart);
  const minutes = end !== null && start !== null && end > start ? Math.round((end - start) / 60) : null;
  const now = context.now();
  const unified = typeof summary.membershipType === "string" && summary.membershipType.toLowerCase().startsWith("unified_") && summary.limitType === "user";
  let percent = finiteNumber(plan.totalPercentUsed) ?? ratio(plan) ?? ratio(individual.overall) ?? ratio(team.pooled);
  let requests = false;
  let teamSpend: number | null = null;
  const teamPlan = ["enterprise", "business", "team", "teams"].includes(String(summary.membershipType).toLowerCase()) || summary.limitType === "team";
  if (teamPlan && isRecord(user) && typeof user.email === "string") {
    try { teamSpend = await teamBudget(context, cookie, user.email); } catch { /* Team billing is optional. */ }
  }
  if (teamSpend !== null) percent = teamSpend;
  if (!unified && teamSpend === null && isRecord(user) && typeof user.sub === "string") {
    const legacy = await optional(`/api/usage?user=${encodeURIComponent(user.sub)}`);
    const model = isRecord(legacy) && isRecord(legacy["gpt-4"]) ? legacy["gpt-4"] : null;
    const used = finiteNumber(model?.numRequests);
    const limit = finiteNumber(model?.maxRequestUsage);
    if (used !== null && limit !== null && limit > 0) { percent = Math.min(100, used / limit * 100); requests = true; }
  }
  const windows: FeedWindow[] = [];
  let replacesMonthly = false;
  let weekly: FeedWindow | null = null;
  if (isRecord(sand)) {
    const used = finiteNumber(sand.usagePercent);
    const hasLimit = sand.includedLimitZero === undefined ? sand.hasNonZeroIncludedLimit === true : sand.includedLimitZero === false;
    const trial = !hasLimit && (isoToSeconds(sand.sandTrialExpiresAt) ?? 0) > now;
    if (used !== null && (hasLimit || trial)) {
      const reset = trial ? null : isoToSeconds(sand.nextResetTimestampUtc);
      weekly = feedWindow(reset === null ? null : 10080, Math.min(100, used), reset, now, reset === null ? "trial" : "7d");
      if (sand.isUnified === true && !requests && reset !== null && reset > now) { percent = null; replacesMonthly = true; }
    }
  }
  if (weekly) windows.push(weekly);
  if (percent !== null) windows.push(feedWindow(minutes, percent, end, now, minutes === null ? "plan" : undefined));
  if (!requests && teamSpend === null && !replacesMonthly && windows.length < 2 && finiteNumber(plan.autoPercentUsed) !== null) windows.push(feedWindow(minutes, Number(plan.autoPercentUsed), end, now, "auto"));
  if (windows.length < 2) {
    let demand = ratio(individual.onDemand) ?? ratio(team.onDemand);
    let reset = end;
    if (unified) {
      const status = await optional("/api/dashboard/v2/usage-status?scope=user");
      const monthly = isRecord(status) && status.availability === "available" && isRecord(status.monthlyUsage) ? status.monthlyUsage : null;
      const used = finiteNumber(monthly?.usedCents), limit = finiteNumber(monthly?.limitCents);
      const begin = isoToSeconds(monthly?.periodStart), finish = isoToSeconds(monthly?.resetsAt);
      if (used !== null && used >= 0 && limit !== null && limit > 0 && begin !== null && finish !== null && begin <= now && now < finish) { demand = used / limit * 100; reset = finish; }
    }
    if (demand !== null) windows.push(feedWindow(minutes, demand, reset, now, "extra"));
  }
  windows.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  return { provider: "cursor", account: accountLabel(isRecord(user) && typeof user.email === "string" ? user.email : null),
    observed_at: new Date(now * 1000).toISOString(), windows: windows.slice(0, 2), blocked: windows.some(w => (w.used_percent ?? 0) >= 100) };
}

export const cursor: Provider = {
  id: "cursor", name: NAME,
  async fetch(context) {
    const entry = await providerEntry(context, "cursor");
    const base = { provider: "cursor", account: accountLabel(null), observed_at: new Date(context.now() * 1000).toISOString(), blocked: false, windows: [] };
    const optionalCredential = async <T>(read: () => Promise<T>): Promise<T | null> => {
      try { return await read(); } catch { return null; }
    };
    const candidates: string[] = [];
    const add = (value: string | null) => { if (value && !candidates.includes(value)) candidates.push(value); };
    if (entry.cookieSource === "manual") {
      if (typeof entry.cookieHeader !== "string" || !entry.cookieHeader.trim()) throw new NotConfigured(NAME);
      add(await cookieHeader(context, "cursor", { domains: ["cursor.com", "www.cursor.com", "cursor.sh", "authenticator.cursor.sh"] }));
    } else {
      if (context.platform === "darwin") add(await optionalCredential(() => localCookie(context)));
      if (entry.cookieSource !== "off") {
        const cached = json(await optionalCredential(() => context.readKeychain("com.steipete.codexbar.cache", "cookie.cursor")));
        if (isRecord(cached) && typeof cached.cookieHeader === "string") add(cached.cookieHeader);
        add(await cookieHeader(context, "cursor", { domains: ["cursor.com", "www.cursor.com", "cursor.sh", "authenticator.cursor.sh"] }));
        add(await optionalCredential(() => storedCookie(context)));
      }
      if (context.platform !== "darwin") {
        add(await optionalCredential(() => localCookie(context)));
        const auth = json(await optionalCredential(() => context.readFile(join(context.env.XDG_CONFIG_HOME || join(context.home, ".config"), "cursor/auth.json"))));
        if (isRecord(auth) && typeof auth.accessToken === "string") add(appCookie(auth.accessToken, context.now()));
      }
    }
    if (!candidates.length) throw new NotConfigured(NAME);
    for (const cookie of candidates) {
      try { return [await usage(context, cookie)]; } catch (error) {
        if (!(error instanceof HttpError) || (error.status !== 401 && error.status !== 403)) throw error;
      }
    }
    return [{ ...base, error: "sign in" }];
  },
};
