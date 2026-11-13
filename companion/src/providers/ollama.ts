import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

function amount(value: number, prefix = "$"): string {
  const fixed = `${prefix}${value.toFixed(2)}`;
  return fixed.length <= 12 ? fixed : `${prefix}${value.toExponential(2)}`;
}

const SIGN_IN = Symbol("sign in");

export const ollama: Provider = {
  id: "ollama",
  name: "Ollama",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "ollama", ["OLLAMA_API_KEY"]);
    if (!key) throw new NotConfigured("Ollama");
    const now = context.now();
    const base: FeedAccount = {
      provider: "ollama", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    async function request(url: string, init: RequestInit = {}): Promise<unknown> {
      const response = await context.fetch(url, {
        ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) return SIGN_IN;
      if (response.status === 429) throw new RateLimited("Ollama", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Ollama", response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError("Ollama", response.status);
      }
    }
    const data = await request("https://ollama.com/api/balance");
    if (data === SIGN_IN) return [{ ...base, error: "sign in" }];
    if (!isRecord(data)) throw new HttpError("Ollama", 200);
    const number = (value: unknown): number => {
      if (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) throw new HttpError("Ollama", 200);
      const parsed = finiteNumber(value);
      if (parsed === null) throw new HttpError("Ollama", 200);
      return parsed;
    };
    const reset = (value: unknown): number | null => {
      if (value == null) return null;
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
        throw new HttpError("Ollama", 200);
      }
      const result = isoToSeconds(value);
      const [year, month, day] = value.slice(0, 10).split("-").map(Number);
      if (result === null || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new HttpError("Ollama", 200);
      return result;
    };
    const windows: FeedWindow[] = [];
    if (data.included != null) {
      const included = data.included;
      if (!isRecord(included)) throw new HttpError("Ollama", 200);
      if (included.session != null || included.weekly != null) {
        for (const [key, minutes] of [["session", 300], ["weekly", 10080]] as const) {
          const entry = included[key];
          if (entry == null) continue;
          if (!isRecord(entry)) throw new HttpError("Ollama", 200);
          const remaining = number(entry.remaining_percent);
          if (remaining < 0 || remaining > 100) throw new HttpError("Ollama", 200);
          windows.push(feedWindow(minutes, 100 - remaining, reset(entry.resets_at), now));
        }
      } else {
        const allowance = number(included.allowance_usd);
        const balance = number(included.balance_usd);
        const used = Math.max(0, allowance - balance);
        if (allowance < 0 || !Number.isFinite(used)) throw new HttpError("Ollama", 200);
        if (included.period != null && !isRecord(included.period)) throw new HttpError("Ollama", 200);
        const until = isRecord(included.period) ? reset(included.period.until) : null;
        if (allowance > 0) windows.push(feedWindow(43200, Math.min(100, used / allowance * 100), until, now));
        else windows.push(valueWindow("spent", amount(used)));
      }
    }
    if (data.purchased != null) {
      if (!isRecord(data.purchased)) throw new HttpError("Ollama", 200);
      const balance = number(data.purchased.balance_usd);
      if (windows.length < 2) windows.push(valueWindow("bal", amount(balance)));
    }
    if (windows.length === 0) throw new HttpError("Ollama", 200);
    return [{ ...base, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100), windows }];
  },
};
