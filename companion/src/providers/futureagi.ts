import {
  accountLabel,
  feedWindow,
  valueWindow,
  isoToSeconds,
  isRecord,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const futureagi: Provider = {
  id: "futureagi",
  name: "Future AGI",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "futureagi", ["FI_API_KEY"]);
    if (!key) throw new NotConfigured("Future AGI");
    const now = context.now();
    const entry = await providerEntry(context, "futureagi");
    const secrets = isRecord(entry.pluginSecrets) ? entry.pluginSecrets : {};
    const secret =
      (typeof secrets.FI_SECRET_KEY === "string" ? secrets.FI_SECRET_KEY.trim() : "") ||
      context.env.FI_SECRET_KEY?.trim();
    if (!secret) throw new NotConfigured("Future AGI");
    const base: FeedAccount = {
      provider: "futureagi",
      provider_name: "Future AGI",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const headers = { "X-Api-Key": key, "X-Secret-Key": secret };
    const response = await context.fetch("https://api.futureagi.com/usage/v2/usage-overview/", {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Future AGI", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Future AGI", response.status);
    const fail = (): never => {
      throw new HttpError("Future AGI", response.status);
    };
    const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : fail());
    const number = (value: unknown, signed = false): number =>
      typeof value === "number" && Number.isFinite(value) && value <= Number.MAX_SAFE_INTEGER && (signed || value >= 0)
        ? value
        : fail();
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
    const result = record(data.result);
    if (
      data.status !== true ||
      !Array.isArray(result.dimensions) ||
      result.dimensions.length === 0 ||
      result.dimensions.length > 16
    )
      fail();
    const date = (value: unknown): number => {
      if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)
      )
        return fail();
      return isoToSeconds(value) ?? fail();
    };
    const start = date(result.billing_period_start);
    const end = date(result.billing_period_end);
    if (end <= start) fail();
    number(result.total_estimated_cost);
    const dimensions = result.dimensions;
    if (!Array.isArray(dimensions)) return fail();
    const keys = new Set<string>();
    const selected = new Map<string, FeedWindow>();
    for (const raw of dimensions) {
      const meter = record(raw);
      if (
        typeof meter.key !== "string" ||
        keys.has(meter.key) ||
        typeof meter.display_name !== "string" ||
        !meter.display_name.trim() ||
        typeof meter.display_unit !== "string" ||
        !meter.display_unit.trim()
      )
        return fail();
      keys.add(meter.key);
      const used = number(meter.current_usage);
      const allowance = number(meter.free_allowance);
      if (used > Number.MAX_SAFE_INTEGER || allowance > Number.MAX_SAFE_INTEGER) fail();
      selected.set(
        meter.key,
        allowance > 0
          ? feedWindow(
              Math.round((end - start) / 60),
              Math.min(100, (used / allowance) * 100),
              end,
              now,
              meter.key === "ai_credits" ? "credits" : "reqs",
            )
          : valueWindow(meter.key === "ai_credits" ? "credits" : "reqs", compact(used), end),
      );
    }
    for (const key of ["ai_credits", "gateway_requests"]) {
      const window = selected.get(key);
      if (window) windows.push(window);
    }
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
