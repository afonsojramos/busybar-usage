import { accountLabel, valueWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const fal: Provider = {
  id: "fal",
  name: "fal",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "fal", ["FAL_KEY"]);
    if (!key) throw new NotConfigured("fal");
    const now = context.now();
    const base: FeedAccount = {
      provider: "fal",
      provider_name: "fal",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const headers = { Authorization: `Key ${key}` };
    const response = await context.fetch("https://api.fal.ai/v1/account/billing?expand=credits", {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("fal", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("fal", response.status);
    const fail = (): never => {
      throw new HttpError("fal", response.status);
    };
    const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : fail());
    const number = (value: unknown, signed = false): number =>
      typeof value === "number" && Number.isFinite(value) && (signed || value >= 0) ? value : fail();
    const compact = (value: number): string => {
      const text = new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);
      return text.length <= 8 ? text : value.toExponential(0);
    };
    let data: Record<string, unknown>;
    try {
      data = record(await response.json());
    } catch {
      return fail();
    }
    const windows: FeedWindow[] = [];
    const credits = record(data.credits);
    const raw = credits.current_balance;
    const balance =
      typeof raw === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(raw) ? number(Number(raw), true) : number(raw, true);
    const currency =
      typeof credits.currency === "string" && /^[A-Z]{3}$/.test(credits.currency) ? credits.currency : "USD";
    const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency }).format(balance);
    windows.push(valueWindow("balance", formatted.length <= 12 ? formatted : `${compact(balance)} ${currency}`));
    return [
      {
        ...base,
        account: accountLabel(typeof data.email === "string" ? data.email : null),
        windows,
        blocked: base.blocked || windows.some((window) => (window.used_percent ?? 0) >= 100),
      },
    ];
  },
};
