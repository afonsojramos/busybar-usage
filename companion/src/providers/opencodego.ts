import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

function object(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try { const parsed: unknown = JSON.parse(text); return isRecord(parsed) ? parsed : null; } catch { return null; }
}
function number(root: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) { const value = finiteNumber(root[key]); if (value !== null) return value; }
  return null;
}
function date(value: unknown): number | null {
  const n = finiteNumber(value);
  return n === null ? isoToSeconds(value) : n > 1e12 ? n / 1000 : n;
}

export function parseOpenCodeGo(root: unknown, now: number, web = false): FeedWindow[] | null {
  if (!isRecord(root)) return null;
  const access = isRecord(root.access) ? root.access : null;
  const meters = access && isRecord(access.meters) ? access.meters : null;
  const usage = meters ?? (isRecord(root.usage) ? root.usage : root);
  const lanes = meters ? ["fiveHour", "week", "month"] : ["rolling", "weekly", "monthly"];
  const windows: FeedWindow[] = [];
  for (const [index, key] of lanes.entries()) {
    let lane: unknown = usage[key] ?? usage[`${key}Usage`];
    if (isRecord(lane) && isRecord(lane.window)) lane = lane.window;
    if (!isRecord(lane)) { if (index === 0) return null; continue; }
    let percent = number(lane, ["usagePercent", "usedPercent", "percentUsed", "percent", "usage_percent", "used_percent", "utilization", "utilizationPercent", "utilization_percent", "usage"]);
    const direct = percent !== null;
    if (percent === null) {
      const used = number(lane, ["used", "usage", "consumed", "count", "usedTokens", "usedMicroCents"]);
      const limit = number(lane, ["limit", "total", "quota", "max", "cap", "tokenLimit", "limitMicroCents"]);
      if (used !== null && limit !== null && limit > 0) percent = used / limit * 100;
    }
    if (percent === null) { if (index < 2) return null; continue; }
    if (web && direct && percent >= 0 && percent <= 1) percent *= 100;
    const seconds = number(lane, ["resetInSec", "resetInSeconds", "resetSeconds", "reset_sec", "reset_in_sec", "resetsInSec", "resetsInSeconds", "resetIn", "resetSec"]);
    let reset = seconds === null ? null : now + Math.max(0, seconds);
    if (reset === null) for (const name of ["resetAt", "resetsAt", "reset_at", "resets_at", "nextReset", "next_reset", "renewAt", "renew_at"]) {
      reset = date(lane[name]); if (reset !== null) break;
    }
    if (reset === null && index === 2 && access) reset = date(access.endsAt);
    windows.push(feedWindow([300, 10080, 43200][index], Math.max(0, Math.min(100, percent)), reset, now));
  }
  return windows.length ? windows : null;
}

export function parseOpenCodeGoLegacy(text: string, now: number): FeedWindow[] | null {
  const parsed = parseOpenCodeGo(object(text), now, true);
  if (parsed) return parsed;
  const windows: FeedWindow[] = [];
  for (const [index, key] of ["rollingUsage", "weeklyUsage", "monthlyUsage"].entries()) {
    const portion = text.match(new RegExp(`${key}[^}]*?\\{([^}]+)\\}`))?.[1];
    const percent = finiteNumber(portion?.match(/usagePercent\s*:\s*([\d.]+)/)?.[1]);
    const reset = finiteNumber(portion?.match(/resetInSec\s*:\s*(\d+)/)?.[1]);
    if (percent === null || reset === null) { if (index === 0) return null; continue; }
    windows.push(feedWindow([300, 10080, 43200][index], percent, now + reset, now));
  }
  return windows.length ? windows : null;
}

async function cliCredential(context: Context): Promise<string | null> {
  const data = context.env.XDG_DATA_HOME;
  const directory = join(data && isAbsolute(data) ? data : join(context.home, ".local/share"), "opencode");
  const filename = context.env.OPENCODE_DB ?? "opencode.db";
  if (filename === ":memory:") return null;
  const path = isAbsolute(filename) ? filename : join(directory, filename);
  const tables = await context.querySqlite(path, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'");
  if (tables?.length) {
    const rows = await context.querySqlite(path, "SELECT integration_id, value FROM credential WHERE active = 1 AND integration_id IN ('opencode-go', 'opencode') ORDER BY CASE integration_id WHEN 'opencode-go' THEN 0 ELSE 1 END LIMIT 2");
    if (!rows?.length) return null;
    if (rows.length > 1 && rows[0].integration_id === rows[1].integration_id) throw new HttpError("OpenCode Go", 401);
    const entry = typeof rows[0].value === "string" ? object(rows[0].value) : null;
    if (!entry) throw new HttpError("OpenCode Go", 401);
    const token = entry.type === "key" ? entry.key : entry.type === "oauth" ? entry.access : null;
    const expires = finiteNumber(entry.expires);
    if (entry.type === "oauth" && (expires === null || !Number.isSafeInteger(expires) || expires <= context.now() * 1000)) throw new HttpError("OpenCode Go", 401);
    if (typeof token !== "string" || !token || /\s/.test(token)) throw new HttpError("OpenCode Go", 401);
    return token;
  }
  const legacy = object(await context.readFile(join(directory, "auth.json")));
  const entry = legacy?.["opencode-go"];
  if (!isRecord(entry) || entry.type !== "api") return null;
  if (typeof entry.key !== "string" || !entry.key || /\s/.test(entry.key)) throw new HttpError("OpenCode Go", 401);
  return entry.key;
}

async function localUsage(context: Context): Promise<FeedWindow[] | null> {
  const data = context.env.XDG_DATA_HOME;
  const directory = join(data && isAbsolute(data) ? data : join(context.home, ".local/share"), "opencode");
  const filename = context.env.OPENCODE_DB ?? "opencode.db";
  if (filename === ":memory:") return null;
  const path = isAbsolute(filename) ? filename : join(directory, filename);
  const tables = await context.querySqlite(path, "SELECT name FROM sqlite_master WHERE type = 'table'");
  if (tables === null) return null;
  const names = new Set(tables.map(row => row.name));
  if (!names.has("message") && !names.has("session_message")) return null;
  const messages = `SELECT id AS messageID,
    CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
    CAST(json_extract(data, '$.cost') AS REAL) AS cost,
    json_type(data, '$.cost') IN ('integer', 'real') AS hasCost
    FROM message WHERE json_valid(data) AND json_extract(data, '$.providerID') = 'opencode-go'
    AND json_extract(data, '$.role') = 'assistant'`;
  const legacy = !names.has("message") ? "SELECT NULL AS messageID, NULL AS createdMs, NULL AS cost WHERE 0"
    : !names.has("part") ? `SELECT messageID, createdMs, cost FROM (${messages}) WHERE hasCost`
      : `SELECT m.messageID,
        CASE WHEN p.message_id IS NULL THEN m.createdMs ELSE
          CAST(COALESCE(json_extract(p.data, '$.time.created'), p.time_created, m.createdMs) AS INTEGER) END AS createdMs,
        CASE WHEN p.message_id IS NULL THEN m.cost ELSE CAST(json_extract(p.data, '$.cost') AS REAL) END AS cost
        FROM (${messages}) m LEFT JOIN part p ON m.messageID = p.message_id AND
          CASE WHEN json_valid(p.data) THEN json_extract(p.data, '$.type') = 'step-finish'
            AND json_type(p.data, '$.cost') IN ('integer', 'real') ELSE 0 END
        WHERE p.message_id IS NOT NULL OR m.hasCost`;
  const modern = names.has("session_message") ? `UNION ALL SELECT s.id AS messageID,
    CAST(COALESCE(json_extract(s.data, '$.time.created'), s.time_created) AS INTEGER) AS createdMs,
    CAST(json_extract(s.data, '$.cost') AS REAL) AS cost
    FROM session_message s WHERE s.type IN ('assistant', 'compaction') AND json_valid(s.data)
    AND json_extract(s.data, '$.model.providerID') = 'opencode-go'
    AND json_type(s.data, '$.cost') IN ('integer', 'real')
    AND NOT EXISTS (SELECT 1 FROM legacy_usage m WHERE m.messageID = s.id
      AND m.createdMs > 0 AND m.cost BETWEEN 0 AND 1.7976931348623157e308)` : "";
  const now = context.now() * 1000;
  const rows = await context.querySqlite(path, `WITH legacy_usage AS NOT MATERIALIZED (${legacy}),
    usage AS (SELECT * FROM legacy_usage ${modern})
    SELECT SUM(CASE WHEN createdMs >= ? THEN cost ELSE 0 END) AS fiveHour,
      SUM(cost) AS week FROM usage WHERE createdMs BETWEEN ? AND ? AND cost >= 0`,
    [now - 5 * 3600000, now - 7 * 86400000, now]);
  const fiveHour = finiteNumber(rows?.[0]?.fiveHour); const week = finiteNumber(rows?.[0]?.week);
  if (fiveHour === null || week === null) return null;
  // The feed has no confidence field; local spend must not masquerade as an account quota.
  return [valueWindow("local5h", money(fiveHour)), valueWindow("local7d", money(week))];
}

function money(value: number): string {
  return Math.abs(value) < 1e8 ? `$${value.toFixed(2)}` : `$${value.toExponential(2)}`;
}

export const opencodego: Provider = {
  id: "opencodego", name: "OpenCode Go",
  async fetch(context) {
    const now = context.now();
    const base = { provider: "opencodego", account: accountLabel(null), blocked: false, windows: [], observed_at: new Date(now * 1000).toISOString() };
    const finish = (windows: FeedWindow[]) => [{ ...base, windows: windows.slice(0, 2), blocked: windows.some(w => (w.used_percent ?? 0) >= 100) }];
    async function get(url: string, headers: Record<string, string>): Promise<Response> {
      const response = await context.fetch(url, { headers, signal: AbortSignal.timeout(30_000), redirect: "manual" });
      if (response.status === 429) throw new RateLimited("OpenCode Go", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("OpenCode Go", response.status);
      return response;
    }
    const entry = await providerEntry(context, "opencodego");
    const workspaceSetting = entry.workspaceID ?? context.env.CODEXBAR_OPENCODEGO_WORKSPACE_ID;
    const scoped = workspaceSetting !== undefined || entry.cookieSource === "manual" || entry.tokenAccounts !== undefined;
    let token = await apiKey(context, "opencodego", ["OPENCODE_API_KEY"]);
    try {
      const cookie = token ? null : await cookieHeader(context, "opencodego", { domains: ["opencode.ai"], required: ["auth", "__Host-auth"] });
      if (!token && !cookie && !scoped) token = await cliCredential(context);
      if (token) {
        const response = await get("https://opencode.ai/zen/go/v1/usage", { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "CodexBar" });
        const windows = parseOpenCodeGo(object(await response.text()), now);
        if (!windows) throw new HttpError("OpenCode Go", response.status);
        return finish(windows);
      }
      if (!cookie) {
        if (!scoped) { const local = await localUsage(context); if (local) return finish(local); }
        throw new NotConfigured("OpenCode Go");
      }
      const headers: Record<string, string> = { Cookie: cookie, Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36" };
      let workspace: string | null = typeof workspaceSetting === "string" ? workspaceSetting.match(/(?:wrk_|org_)[A-Za-z0-9_-]+/)?.[0] ?? null : null;
      if (workspaceSetting !== undefined && workspace === null) throw new NotConfigured("OpenCode Go");
      if (!workspace) {
        try {
          const response = await get("https://opencode.ai/console/api/orgs", headers);
          let data: unknown; try { data = await response.json(); } catch { throw new HttpError("OpenCode Go", 200); }
          const row = Array.isArray(data) ? data.find(item => isRecord(item) && typeof item.id === "string" && /^(wrk_|org_)[A-Za-z0-9_-]+$/.test(item.id)) : null;
          workspace = isRecord(row) && typeof row.id === "string" ? row.id : null;
        } catch (error) {
          if (!(error instanceof HttpError) || ![404, 405].includes(error.status)) throw error;
          const id = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f";
          const response = await get(`https://opencode.ai/_server?id=${id}`, {
            ...headers, "X-Server-Id": id, "X-Server-Instance": `server-fn:${randomUUID()}`,
            Origin: "https://opencode.ai", Referer: "https://opencode.ai/", Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
          });
          const text = await response.text();
          workspace = text.match(/(?:["']?id["']?\s*:\s*["'])(wrk_[A-Za-z0-9_-]+)/)?.[1] ?? null;
          if (!workspace) {
            const page = await get("https://opencode.ai/", { ...headers, Accept: "text/html" });
            workspace = (await page.text()).match(/\bwrk_[A-Za-z0-9_-]+/)?.[0] ?? null;
          }
        }
        if (!workspace) throw new HttpError("OpenCode Go", 200);
      }
      headers["x-org-id"] = workspace;
      let windows: FeedWindow[] | null = null;
      try {
        const response = await get("https://opencode.ai/console/api/go/status", headers);
        const text = await response.text();
        windows = parseOpenCodeGo(object(text), now, true);
        if (!windows && text.trim() !== "null" && object(text)?.access !== null) throw new HttpError("OpenCode Go", 200);
      } catch (error) {
        if (!(error instanceof HttpError) || ![404, 405].includes(error.status)) throw error;
        const response = await get(`https://opencode.ai/workspace/${workspace}/go`, { ...headers, Accept: "text/html" });
        windows = parseOpenCodeGoLegacy(await response.text(), now);
        if (!windows) throw new HttpError("OpenCode Go", 200);
      }
      if (windows) return finish(windows);
      let balance: number | null = null;
      try {
        const response = await get("https://opencode.ai/console/api/billing/status", headers);
        const billing = object(await response.text());
        balance = billing?.billingMode === "prepaid" && billing.mode === "pay-as-you-go"
          && typeof billing.balanceMicroCents === "string" && /^-?\d+$/.test(billing.balanceMicroCents)
          ? finiteNumber(billing.balanceMicroCents) : null;
      } catch (error) {
        if (!(error instanceof HttpError) || ![404, 405].includes(error.status)) throw error;
        const id = "c83b78a614689c38ebee981f9b39a8b377716db85c1fd7dbab604adc02d3313d";
        const params = new URLSearchParams({ id, args: JSON.stringify([workspace]) });
        const response = await get(`https://opencode.ai/_server?${params}`, {
          ...headers, "X-Server-Id": id, "X-Server-Instance": `server-fn:${randomUUID()}`,
          Origin: "https://opencode.ai", Referer: `https://opencode.ai/workspace/${workspace}`,
          Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
        });
        const text = await response.text();
        if (/customerID\s*:\s*"[^"\n]+"/.test(text)) balance = finiteNumber(text.match(/\bbalance\s*:\s*(?:\$R\[\d+\]\s*=\s*)?(-?[0-9]+(?:\.[0-9]+)?)/)?.[1]);
      }
      if (balance === null) throw new HttpError("OpenCode Go", 200);
      return [{ ...finish([valueWindow("balance", money(balance / 1e8))])[0], blocked: balance <= 0 }];
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
