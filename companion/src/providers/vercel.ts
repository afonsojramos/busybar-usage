import { accountLabel, feedWindow, valueWindow, finiteNumber, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "vercel";
const NAME = "Vercel";
function fail(): never { throw new HttpError(NAME, 200); }
function object(value: unknown): Record<string, unknown> { return isRecord(value) ? value : fail(); }
function number(value: unknown): number { return finiteNumber(value) ?? fail(); }
function money(value: unknown): number {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) return fail();
  return number(value);
}
function usd(value: number): string {
  const text = `$${value.toFixed(2)}`;
  return text.length <= 12 ? text : `$${value.toExponential(3)}`;
}
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
  const entry = await providerEntry(context, ID);
  const pluginSecrets = isRecord(entry.pluginSecrets) ? entry.pluginSecrets : {};
  const token = await apiKey(context, ID, ["VERCEL_ACCESS_TOKEN"]);
  const personal = context.env.VERCEL_ACCESS_TOKEN?.trim() || (typeof pluginSecrets.VERCEL_ACCESS_TOKEN === "string" ? pluginSecrets.VERCEL_ACCESS_TOKEN.trim() : "");
  if (!personal) {
    const key = await apiKey(context, ID, ["AI_GATEWAY_API_KEY"]);
    if (!key) throw new NotConfigured(NAME);
    const data = await read(context, "https://ai-gateway.vercel.sh/v1/credits", key);
    const balance = money(data.balance), spent = money(data.total_used);
    if (spent < 0) return fail();
    return account(context, [valueWindow("balance", usd(balance)), valueWindow("spent", usd(spent))]);
  }
  const key = personal === context.env.VERCEL_ACCESS_TOKEN?.trim() ? token : personal;
  if (!key) throw new NotConfigured(NAME);
  const team = context.env.VERCEL_TEAM_ID || entry.workspaceID;
  if (typeof team !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(team)) throw new NotConfigured(NAME);
  const user = object((await read(context, "https://api.vercel.com/v2/user", key)).user);
  if (typeof user.id !== "string" || !user.id) return fail();
  const matches: Record<string, unknown>[] = [], cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    const query = `teamId=${encodeURIComponent(team)}&scopeType=user&limit=200` + (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`);
    const data = await read(context, `https://api.vercel.com/ai-gateway/budgets/list?${query}`, key);
    if (!Array.isArray(data.budgets)) return fail();
    for (const raw of data.budgets) {
      if (!isRecord(raw) || raw.scopeType !== "user" || ![user.id, `usr_${user.id}`].includes(String(raw.scopeId))) continue;
      if (typeof raw.active !== "boolean" || typeof raw.archived !== "boolean" || raw.source !== undefined && raw.source !== "default") return fail();
      if (raw.active && !raw.archived) matches.push(raw);
    }
    if (data.nextCursor == null) break;
    if (typeof data.nextCursor !== "string" || !data.nextCursor || cursors.has(data.nextCursor) || page >= 19) return fail();
    cursor = data.nextCursor; cursors.add(cursor);
  }
  const custom = matches.filter(b => b.source !== "default"), effective = custom.length ? custom : matches;
  if (effective.length > 1) return fail();
  const budget = effective[0];
  if (!budget) return account(context, [], user.email).map(a => ({ ...a, error: "no budget" }));
  if (typeof budget.limitAmount !== "number" || typeof budget.currentSpend !== "number") return fail();
  const limit = number(budget.limitAmount), spent = number(budget.currentSpend);
  if (limit <= 0 || spent < 0) return fail();
  const now = new Date(context.now() * 1000), year = now.getUTCFullYear(), month = now.getUTCMonth(), day = now.getUTCDate();
  let reset: number | null = null, minutes: number | null = null;
  switch (budget.refreshPeriod) {
    case "daily": minutes = 1440; reset = Date.UTC(year, month, day + 1) / 1000; break;
    case "weekly": minutes = 10080; reset = Date.UTC(year, month, day - (now.getUTCDay() + 6) % 7 + 7) / 1000; break;
    case "monthly": minutes = 43200; reset = Date.UTC(year, month + 1, 1) / 1000; break;
    case "none": break;
    default: return fail();
  }
  return account(context, [feedWindow(minutes, spent / limit * 100, reset, context.now(), minutes === null ? "budget" : undefined)], user.email);
}
export const vercel: Provider = {
  id: ID, name: NAME, async fetch(context) {
    try { return await execute(context); } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403))
        return account(context, []).map(a => ({ ...a, error: "sign in" }));
      throw error;
    }
  }
};
