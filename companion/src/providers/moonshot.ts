import { accountLabel, finiteNumber, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { resolveKey, type ResolvedKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

function amount(value: number, prefix = "$"): string {
  const fixed = `${prefix}${value.toFixed(2)}`;
  return fixed.length <= 12 ? fixed : `${prefix}${value.toExponential(2)}`;
}

/** The host region for a key; a saved CodexBar key stays on the region it was saved for. */
function keyRegion(context: Context, resolved: ResolvedKey): string {
  const selected = context.env.MOONSHOT_REGION?.trim().replace(/^["']|["']$/g, "").toLowerCase();
  const fallback = selected === "china" ? "china" : "international";
  if (resolved.source !== "codexbar" || resolved.entry === null) return fallback;
  const entry = resolved.entry;
  const bound = entry.apiKeyRegion ?? entry.region ?? "international";
  const region = selected ?? entry.region ?? bound;
  // Saved regional keys must never cross Moonshot hosts.
  if ((region !== "international" && region !== "china") || region !== bound) throw new NotConfigured("Moonshot");
  return region;
}

const SIGN_IN = Symbol("sign in");

export const moonshot: Provider = {
  id: "moonshot",
  name: "Moonshot",
  async fetch(context): Promise<FeedAccount[]> {
    const resolved = await resolveKey(context, "moonshot", ["MOONSHOT_API_KEY", "MOONSHOT_KEY"]);
    if (!resolved) throw new NotConfigured("Moonshot");
    const key = resolved.key;
    const now = context.now();
    const base: FeedAccount = {
      provider: "moonshot", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    async function request(url: string, init: RequestInit = {}): Promise<unknown> {
      const response = await context.fetch(url, {
        ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) return SIGN_IN;
      if (response.status === 429) throw new RateLimited("Moonshot", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Moonshot", response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError("Moonshot", response.status);
      }
    }
    const region = keyRegion(context, resolved);
    const china = region === "china";
    const data = await request(`https://api.moonshot.${china ? "cn" : "ai"}/v1/users/me/balance`);
    if (data === SIGN_IN) return [{ ...base, error: "sign in" }];
    if (!isRecord(data) || !Number.isInteger(data.code) || typeof data.scode !== "string"
      || data.code !== 0 || data.status !== true || !isRecord(data.data)) throw new HttpError("Moonshot", 200);
    const values = data.data;
    if ([values.available_balance, values.cash_balance, values.voucher_balance]
      .some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new HttpError("Moonshot", 200);
    const balance = finiteNumber(values.available_balance);
    const cash = finiteNumber(values.cash_balance);
    if (balance === null || cash === null) throw new HttpError("Moonshot", 200);
    const prefix = china ? "¥" : "$";
    const windows = [valueWindow("bal", amount(balance, prefix))];
    if (cash < 0) windows.push(valueWindow("owed", amount(-cash, prefix)));
    return [{ ...base, blocked: balance <= 0, windows }];
  },
};
