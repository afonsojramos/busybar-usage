import { accountLabel, feedWindow, finiteNumber, isRecord, valueWindow, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

function epoch(value: unknown): number | null {
  const number = finiteNumber(value);
  return number === null || number <= 1e9 ? null : number > 1e12 ? number / 1000 : number;
}

function percent(value: unknown): number | null {
  return finiteNumber(typeof value === "string" && value.endsWith("%") ? value.slice(0, -1) : value);
}

function lane(model: Record<string, unknown>, weekly: boolean, now: number): FeedWindow | null {
  const prefix = weekly ? "current_weekly" : "current_interval";
  const total = finiteNumber(model[`${prefix}_total_count`]);
  // MiniMax's usage_count fields contain remaining quota, despite their names.
  const remaining = finiteNumber(model[`${prefix}_usage_count`]);
  let remainingPercent = percent(model[`${prefix}_remaining_percent`]);
  const usedPercent = percent(model[`${prefix}_used_percent`]);
  const totalPercent = percent(model[`${prefix}_total_percent`]) ?? 100;
  if (remainingPercent === null && usedPercent !== null && usedPercent >= 0 && totalPercent >= 0) {
    remainingPercent = Math.max(0, Math.min(100, 100 - (usedPercent / (totalPercent || 100)) * 100));
  }
  const status = finiteNumber(model[`${prefix}_status`]);
  const textModel = typeof model.model_name === "string" && isTextModel(model.model_name);
  if (textModel && status === 3 && (usedPercent !== null || (weekly && (remainingPercent ?? 0) >= 100))) {
    return valueWindow(weekly ? "7d" : "5h", "unlimited");
  }
  if (status === 3 && (total ?? 0) === 0 && (remaining ?? 0) === 0 && (remainingPercent ?? 0) >= 100) return null;
  const used =
    remainingPercent !== null
      ? 100 - remainingPercent
      : total !== null && total > 0 && remaining !== null
        ? (Math.max(0, total - remaining) / total) * 100
        : null;
  if (used === null) return null;
  const start = epoch(model[weekly ? "weekly_start_time" : "start_time"]);
  const end = epoch(model[weekly ? "weekly_end_time" : "end_time"]);
  const remains = finiteNumber(model[weekly ? "weekly_remains_time" : "remains_time"]);
  const reset =
    end !== null && end > now
      ? end
      : remains !== null && remains > 0
        ? now + (remains > 1e6 ? remains / 1000 : remains)
        : null;
  const duration = start !== null && end !== null && end > start ? Math.floor((end - start) / 60) : null;
  const minutes = weekly ? 10080 : (duration ?? (usedPercent !== null ? 300 : null));
  return feedWindow(minutes, Math.min(100, Math.max(0, used)), reset, now, minutes === null ? "quota" : undefined);
}

function isTextModel(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "general" || lower.includes("minimax-m") || lower.startsWith("m2.");
}

function parseUsage(root: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(root)) return null;
  const data = isRecord(root.data) ? root.data : root;
  const models = data.model_remains;
  if (!Array.isArray(models) || !models.length || !models.every(isRecord)) return null;
  const text =
    models.find((model) => typeof model.model_name === "string" && isTextModel(model.model_name)) ?? models[0];
  if (!text) return null;
  const weekly = typeof text.model_name === "string" && isTextModel(text.model_name) ? lane(text, true, now) : null;
  const windows = [lane(text, false, now), weekly]
    .filter((window): window is FeedWindow => window !== null)
    .sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  return windows.length ? windows : null;
}

export const minimax: Provider = {
  id: "minimax",
  name: "MiniMax",
  async fetch(context) {
    const key = await apiKey(context, "minimax", ["MINIMAX_CODING_API_KEY", "MINIMAX_API_KEY"]);
    if (!key) throw new NotConfigured("MiniMax");
    const now = context.now();
    const base = {
      provider: "minimax",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const hosts =
      context.env.MINIMAX_HOST?.includes("minimaxi.com") || context.env.MINIMAX_HOST?.includes("minimax.cn")
        ? ["api.minimaxi.com"]
        : ["api.minimax.io", "api.minimaxi.com"];
    let rejected = false;
    let lastStatus = 200;
    for (const host of hosts) {
      for (const path of ["/v1/token_plan/remains", "/v1/api/openplatform/coding_plan/remains"]) {
        const currentEndpoint = path === "/v1/token_plan/remains";
        let response: Response;
        try {
          response = await context.fetch(`https://${host}${path}`, {
            headers: {
              Authorization: `Bearer ${key}`,
              Accept: "application/json",
              "Content-Type": "application/json",
              "MM-API-Source": "CodexBar",
            },
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          if (currentEndpoint) continue;
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new DOMException("MiniMax usage request timed out", "TimeoutError");
          }
          throw new HttpError("MiniMax", 0);
        }
        lastStatus = response.status;
        if (response.status === 429) throw new RateLimited("MiniMax", now + retryAfterSeconds(response.headers, 300));
        if (response.status === 401 || response.status === 403) {
          rejected = true;
          continue;
        }
        if ([302, 404, 405].includes(response.status) && currentEndpoint) continue;
        if (!response.ok) {
          throw new HttpError("MiniMax", response.status);
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          if (currentEndpoint) continue;
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new DOMException("MiniMax usage request timed out", "TimeoutError");
          }
          throw new HttpError("MiniMax", response.status);
        }
        const data = isRecord(body) && isRecord(body.data) ? body.data : body;
        const meta =
          isRecord(data) && isRecord(data.base_resp) ? data.base_resp : isRecord(body) ? body.base_resp : null;
        const status = isRecord(meta) ? finiteNumber(meta.status_code) : null;
        if (status === 1004) {
          rejected = true;
          continue;
        }
        if (status !== null && status !== 0) throw new HttpError("MiniMax", response.status);
        const windows = parseUsage(body, now);
        if (windows === null) {
          if (currentEndpoint) continue;
          throw new HttpError("MiniMax", response.status);
        }
        return [{ ...base, windows, blocked: windows.some((window) => (window.used_percent ?? 0) >= 100) }];
      }
      if (!rejected) break;
    }
    if (rejected) return [{ ...base, error: "sign in" }];
    throw new HttpError("MiniMax", lastStatus);
  },
};
