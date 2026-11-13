import { accountLabel, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const exa: Provider = {
  id: "exa",
  name: "Exa",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "exa", ["EXA_SERVICE_KEY"]);
    if (!key) throw new NotConfigured("Exa");
    const now = context.now();
    const entry = await providerEntry(context, "exa");
    const scope = (typeof entry.workspaceID === "string" ? entry.workspaceID.trim() : "") || context.env.EXA_API_KEY_ID?.trim();
    if (!scope || scope === "." || scope === "..") throw new NotConfigured("Exa");
    const end = new Date(now * 1000);
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    const base: FeedAccount = {
      provider: "exa", provider_name: "Exa", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers = { "x-api-key": key };
    const response = await context.fetch("https://admin-api.exa.ai/team-management/api-keys/" + encodeURIComponent(scope) + "/usage?start_date=" + encodeURIComponent(start.toISOString()) + "&end_date=" + encodeURIComponent(end.toISOString()), {
      headers, signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Exa", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Exa", response.status);
    const fail = (): never => { throw new HttpError("Exa", response.status); };
    const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : fail();
    const number = (value: unknown, signed = false): number =>
      typeof value === "number" && Number.isFinite(value) && (signed || value >= 0) ? value : fail();
    const compact = (value: number): string => {
      const text = new Intl.NumberFormat("en-US", {
        notation: "compact", maximumFractionDigits: 2,
      }).format(value);
      return text.length <= 8 ? text : value.toExponential(0);
    };
    const dollars = (value: number): string => {
      const text = `$${value.toFixed(2)}`;
      return text.length <= 12 ? text : `$${compact(value)}`;
    };
    let data: Record<string, unknown>;
    try { data = record(await response.json()); } catch { return fail(); }
    const windows: FeedWindow[] = [];
    const period = record(data.period);
    if (typeof period.start !== "string" || typeof period.end !== "string" || Date.parse(period.start) !== start.getTime() || Date.parse(period.end) !== now * 1000) fail();
    windows.push(valueWindow("spend", dollars(number(data.total_cost_usd))));
    return [{
      ...base, account: accountLabel(typeof data.email === "string" ? data.email : null),
      windows, blocked: base.blocked || windows.some(window => (window.used_percent ?? 0) >= 100)
    }];
  },
};
