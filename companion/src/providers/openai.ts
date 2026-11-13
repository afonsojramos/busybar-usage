import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  type Context,
  type Provider,
  type RequestOptions,
} from "./types.ts";

const ID = "openai";

function base(context: Context): FeedAccount {
  return {
    provider: ID,
    account: accountLabel(null),
    blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(),
    windows: [],
  };
}

async function request(context: Context, url: string | URL, key: string, init: RequestOptions = {}): Promise<unknown> {
  const response = await context.fetch(url, {
    ...init,
    redirect: "error",
    headers: { Accept: "application/json", Authorization: `Bearer ${key}`, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403) throw new HttpError(ID, response.status);
  if (response.status === 429) throw new RateLimited(ID, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(ID, response.status);
  try {
    return await response.json();
  } catch {
    throw new HttpError(ID, response.status);
  }
}

function finish(context: Context, windows: FeedWindow[], blocked = false): FeedAccount[] {
  return [
    {
      ...base(context),
      windows: windows.slice(0, 2),
      blocked: blocked || windows.some((window) => (window.used_percent ?? 0) >= 100),
    },
  ];
}

function signIn(context: Context, error: unknown): FeedAccount[] {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return [{ ...base(context), error: "sign in" }];
  }
  throw error;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(ID, 200);
  return value;
}

function number(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null) throw new HttpError(ID, 200);
  return parsed;
}

function money(value: number): string {
  return (Math.abs(value) < 1e8 ? `$${value.toFixed(2)}` : `$${value.toExponential(2)}`).slice(0, 12);
}

export const openai: Provider = {
  id: ID,
  name: "OpenAI",
  async fetch(context) {
    const key = await apiKey(context, ID, ["OPENAI_ADMIN_KEY", "OPENAI_API_KEY"]);
    if (!key) throw new NotConfigured(ID);
    const entry = await providerEntry(context, ID);
    const project = context.env.OPENAI_PROJECT_ID || entry.workspaceID;
    const fallback = !project || (!context.env.OPENAI_ADMIN_KEY && !!context.env.OPENAI_API_KEY);
    const daysRaw = Number(context.env.OPENAI_HISTORY_DAYS || 30);
    const days = Number.isInteger(daysRaw) ? Math.max(1, Math.min(365, daysRaw)) : 30;
    try {
      try {
        const start = Math.floor(context.now() / 86400) * 86400 - (days - 1) * 86400;
        let cost = 0,
          tokens = 0;
        for (const type of ["costs", "usage/completions"]) {
          for (let offset = 0; offset < days; offset += 31) {
            const limit = Math.min(31, days - offset);
            let page = "";
            const seen = new Set<string>();
            for (let count = 0; count < 100; count++) {
              const query = new URLSearchParams({
                start_time: String(start + offset * 86400),
                end_time: String(start + (offset + limit) * 86400),
                bucket_width: "1d",
                limit: String(limit),
                group_by: type === "costs" ? "line_item" : "model",
              });
              if (typeof project === "string" && project) query.set("project_ids", project);
              if (page) query.set("page", page);
              const data = object(
                await request(context, `https://api.openai.com/v1/organization/${type}?${query}`, key),
              );
              if (
                !Array.isArray(data.data) ||
                typeof data.has_more !== "boolean" ||
                (data.next_page != null && typeof data.next_page !== "string")
              )
                throw new HttpError(ID, 200);
              for (const raw of data.data) {
                const bucket = object(raw);
                if (
                  !Number.isSafeInteger(bucket.start_time) ||
                  !Number.isSafeInteger(bucket.end_time) ||
                  !Array.isArray(bucket.results)
                )
                  throw new HttpError(ID, 200);
                for (const rawItem of bucket.results) {
                  const item = object(rawItem);
                  if (type === "costs") {
                    const amount = item.amount == null ? {} : object(item.amount);
                    const value = amount.value == null || amount.value === "" ? 0 : number(amount.value);
                    if (number(bucket.start_time) <= context.now()) cost += value;
                  } else {
                    for (const field of [
                      "input_tokens",
                      "output_tokens",
                      "input_cached_tokens",
                      "input_audio_tokens",
                      "output_audio_tokens",
                      "num_model_requests",
                    ]) {
                      if (item[field] != null && (!Number.isSafeInteger(item[field]) || number(item[field]) < 0))
                        throw new HttpError(ID, 200);
                    }
                    if (number(bucket.start_time) <= context.now())
                      tokens += (finiteNumber(item.input_tokens) ?? 0) + (finiteNumber(item.output_tokens) ?? 0);
                  }
                }
              }
              if (!data.has_more) break;
              if (
                typeof data.next_page !== "string" ||
                !data.next_page.trim() ||
                seen.has(data.next_page.trim()) ||
                count === 99
              )
                throw new HttpError(ID, 200);
              page = data.next_page.trim();
              seen.add(page);
            }
          }
        }
        if (!Number.isFinite(cost) || !Number.isSafeInteger(tokens)) throw new HttpError(ID, 200);
        const tokenText = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens);
        return finish(context, [valueWindow(`${days}d`, money(cost)), valueWindow("tokens", tokenText.slice(0, 12))]);
      } catch (error) {
        if (
          !fallback ||
          error instanceof RateLimited ||
          (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
        )
          throw error;
        const data = object(await request(context, "https://api.openai.com/v1/dashboard/billing/credit_grants", key));
        for (const field of ["total_granted", "total_used", "total_available"])
          if (typeof data[field] !== "number" || !Number.isFinite(data[field])) throw new HttpError(ID, 200);
        const total = number(data.total_granted),
          used = number(data.total_used),
          available = number(data.total_available);
        let reset: number | null = null;
        if (data.grants != null) {
          const grants = object(data.grants).data;
          if (!Array.isArray(grants)) throw new HttpError(ID, 200);
          for (const raw of grants) {
            const grant = object(raw);
            const expires = finiteNumber(grant.expires_at);
            if (expires !== null && expires > context.now())
              reset = reset === null ? expires : Math.min(reset, expires);
          }
        }
        return finish(context, [
          feedWindow(null, total > 0 ? (used / total) * 100 : available > 0 ? 0 : 100, reset, context.now(), "credit"),
          valueWindow("USD", money(available)),
        ]);
      }
    } catch (error) {
      return signIn(context, error);
    }
  },
};
