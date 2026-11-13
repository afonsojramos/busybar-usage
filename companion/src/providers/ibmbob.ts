import { accountLabel, feedWindow, valueWindow, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "ibmbob";
const NAME = "IBM Bob";
function fail(): never { throw new HttpError(NAME, 200); }
function object(value: unknown): Record<string, unknown> { return isRecord(value) ? value : fail(); }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : fail(); }
function account(context: Context, windows: FeedWindow[], email?: unknown): FeedAccount[] {
  return [{
    provider: ID, account: accountLabel(typeof email === "string" ? email : null),
    observed_at: new Date(context.now() * 1000).toISOString(), windows,
    blocked: windows.some(w => (w.used_percent ?? 0) >= 100)
  }];
}
async function read(context: Context, url: string, key: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await context.fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...headers },
    redirect: "error", signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try { return object(await response.json()); } catch { throw new HttpError(NAME, response.status); }
}

async function execute(context: Context): Promise<FeedAccount[]> {
  const rawKey = await apiKey(context, ID, ["BOBSHELL_API_KEY"]);
  if (!rawKey) throw new NotConfigured(NAME);
  const key = rawKey.replace(/^(["'])(.*)\1$/, "$2").trim();
  if (!key) throw new NotConfigured(NAME);
  let jwt = false;
  try { jwt = key.split(".").length === 3 && isRecord(JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString())); } catch { }
  const headers = { Authorization: `${jwt ? "Bearer" : "Apikey"} ${key}`, "Content-Type": "application/json", "User-Agent": "CodexBar" };
  const profile = await read(context, "https://api.us-east.bob.ibm.com/admin/v1/profile", key, headers);
  if (!Array.isArray(profile.instances)) return fail();
  let used = 0, limit: number | null = 0, reset: number | null = null, count = 0;
  for (const raw of profile.instances) {
    const instance = object(raw);
    if (typeof instance.instance_id !== "string" || !Array.isArray(instance.teams)) return fail();
    if (typeof instance.user_id !== "string" || !instance.user_id) continue;
    let host = "api.us-east.bob.ibm.com";
    if (typeof instance.region_domain === "string" && instance.region_domain.trim()) {
      const region = instance.region_domain.trim();
      host = region.startsWith("api.") ? region : `api.${region}`;
    }
    let url: URL;
    try { url = new URL(`https://${host}`); } catch { return fail(); }
    if (url.hostname !== host.toLowerCase() || !(url.hostname === "bob.ibm.com" || url.hostname.endsWith(".bob.ibm.com")) ||
      url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) return fail();
    for (const rawTeam of instance.teams) {
      const team = object(rawTeam);
      if (typeof team.id !== "string") return fail();
      if (!team.id) continue;
      const budget = await read(context, `${url.origin}/admin/v1/teams/${encodeURIComponent(team.id)}/users/${encodeURIComponent(instance.user_id)}`, key,
        { ...headers, "x-instance-id": instance.instance_id, "x-team-id": team.id });
      used += Math.max(0, number(budget.usage));
      const teamLimit = budget.budget_limit ?? team.budget_limit;
      if (teamLimit == null || number(teamLimit) < 0) limit = null;
      else if (limit !== null) limit += number(teamLimit);
      const date = typeof instance.refresh_at === "number" ? instance.refresh_at : isoToSeconds(instance.refresh_at);
      if (date !== null && date > 0) reset = reset === null ? date : Math.min(reset, date);
      count++;
    }
  }
  if (!count) return fail();
  return account(context, [limit !== null && limit > 0 ? feedWindow(43200, used / limit * 100, reset, context.now()) : valueWindow("used", `${used.toFixed(1)} coins`.slice(0, 12))]);
}
export const ibmbob: Provider = {
  id: ID, name: NAME, async fetch(context) {
    try { return await execute(context); } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403))
        return account(context, []).map(a => ({ ...a, error: "sign in" }));
      throw error;
    }
  }
};
