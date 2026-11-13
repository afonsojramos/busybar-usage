import { accountLabel, feedWindow, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const cosmic: Provider = {
  id: "cosmic",
  name: "Cosmic AI",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "cosmic", ["COSMIC_TOKEN"]);
    if (!key) throw new NotConfigured("Cosmic AI");
    const now = context.now();
    const entry = await providerEntry(context, "cosmic");
    const scope = (typeof entry.workspaceID === "string" ? entry.workspaceID.trim() : "") || context.env.COSMIC_PROJECT_ID?.trim();
    if (!scope) throw new NotConfigured("Cosmic AI");
    const base: FeedAccount = {
      provider: "cosmic", provider_name: "Cosmic AI", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers = { Authorization: `Bearer ${key}`, Origin: "https://app.cosmicjs.com" };
    const response = await context.fetch("https://dapi.cosmicjs.com/v3/projects/usage?project_id=" + encodeURIComponent(scope), {
      headers, signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Cosmic AI", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Cosmic AI", response.status);
    const fail = (): never => { throw new HttpError("Cosmic AI", response.status); };
    const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : fail();
    const number = (value: unknown, signed = false): number =>
      typeof value === "number" && Number.isFinite(value) && (signed || value >= 0) ? value : fail();
    const integer = (value: unknown): number => {
      const n = number(value);
      return Number.isSafeInteger(n) ? n : fail();
    };
    const compact = (value: number): string => {
      const text = new Intl.NumberFormat("en-US", {
        notation: "compact", maximumFractionDigits: 2,
      }).format(value);
      return text.length <= 8 ? text : value.toExponential(0);
    };
    let data: Record<string, unknown>;
    try { data = record(await response.json()); } catch { return fail(); }
    const windows: FeedWindow[] = [];
    const usage = isRecord(data.usage) && isRecord(data.usage.ai) ? data.usage.ai : {};
    const allowance = isRecord(data.plan_info) && isRecord(data.plan_info.ai_tokens) ? data.plan_info.ai_tokens : {};
    for (const [key, cap, name] of [["input_tokens", "max_input", "input"], ["output_tokens", "max_output", "output"]]) {
      const used = usage[key] == null ? null : integer(usage[key]);
      const raw = allowance[cap];
      let limit: number | null = null;
      if (typeof raw === "string") {
        const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(raw.trim());
        if (match) limit = integer(Number(match[1]) * (match[2].toLowerCase() === "m" ? 1e6 : match[2] ? 1e3 : 1));
      } else if (raw != null) limit = integer(raw);
      if (used !== null && limit !== null && limit > 0) windows.push(feedWindow(null, Math.min(100, used / limit * 100), null, now, name));
      else if (used !== null) windows.push(valueWindow(name, compact(used)));
      else if (limit !== null) windows.push(valueWindow(name, compact(limit)));
      else if (typeof raw === "string" && raw.trim()) windows.push(valueWindow(name, /^unlimited$/i.test(raw.trim()) ? "unlimited" : "unknown"));
    }
    if (!windows.length) fail();
    return [{
      ...base, account: accountLabel(typeof data.email === "string" ? data.email : null),
      windows, blocked: base.blocked || windows.some(window => (window.used_percent ?? 0) >= 100)
    }];
  },
};
