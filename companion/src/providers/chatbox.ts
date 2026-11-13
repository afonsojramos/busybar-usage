import {
  accountLabel,
  feedWindow,
  isoToSeconds,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const ID = "chatbox";
const NAME = "Chatbox AI";
const fail = (): never => {
  throw new HttpError(NAME, 200);
};
function compact(value: number): string {
  const text = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
  return text.length <= 8 ? text : value.toExponential(0);
}

export const chatbox: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: ID,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const key = await apiKey(context, ID, ["CHATBOX_LICENSE_KEY"]);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!key) throw new NotConfigured(NAME);
    if (key.length > 4096 || /[\s\x00-\x1f\x7f-\x9f]/u.test(key)) return [{ ...base, error: "sign in" }];
    headers.Authorization = key;
    headers["Cache-Control"] = "no-store";
    const get = async (url: string, additions: Record<string, string> = {}): Promise<unknown> => {
      const response = await context.fetch(url, {
        headers: { ...headers, ...additions },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited(NAME, now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError(NAME, response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError(NAME, response.status);
      }
    };
    try {
      const body = await get("https://api.chatboxai.app/api/license/detail/realtime");
      if (!isRecord(body)) return fail();
      const windows: FeedWindow[] = [];
      if (body.error || !isRecord(body.data)) return fail();
      const data = body.data;
      const counter = (value: unknown): number | null => {
        if (value == null) return null;
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail();
      };
      type Pool = { used: number; limit: number };
      const pool = (raw: Record<string, unknown>, usedKey: string, limitKey: string): Pool | null => {
        const used = counter(raw[usedKey]),
          limit = counter(raw[limitKey]);
        return used !== null && limit !== null ? { used, limit } : null;
      };
      let plan: Pool | null = null;
      let rewardsReported = false;
      let rewards: Pool = { used: 0, limit: 0 };
      if (data.unified_token_usage_details != null) {
        if (!Array.isArray(data.unified_token_usage_details) || data.unified_token_usage_details.length > 100)
          return fail();
        for (const item of data.unified_token_usage_details) {
          if (!isRecord(item) || typeof item.type !== "string") return fail();
          const p = pool(item, "token_usage", "token_limit");
          if (item.type === "plan") {
            if (plan) return fail();
            plan = p;
          } else if (p && (isoToSeconds(item.expires_at) ?? Infinity) > now) {
            rewardsReported = true;
            rewards = {
              used: (rewards?.used ?? 0) + p.used,
              limit: (rewards?.limit ?? 0) + p.limit,
            };
            if (!Number.isSafeInteger(rewards.used) || !Number.isSafeInteger(rewards.limit)) return fail();
          }
        }
      }
      const total = pool(data, "unified_token_usage", "unified_token_limit");
      if (data.aggregated_reward_details != null) {
        if (!isRecord(data.aggregated_reward_details)) return fail();
        rewardsReported = true;
        rewards = pool(data.aggregated_reward_details, "token_usage", "token_limit") ?? { used: 0, limit: 0 };
      }
      const expansion = pool(data, "expansion_pack_usage", "expansion_pack_limit");
      const images = pool(data, "image_used_count", "image_total_quota");
      if (!plan && !total && !rewardsReported && !expansion && !images) return fail();
      const expires = isoToSeconds(data.token_expire_time) ?? isoToSeconds(data.expires_at);
      const next = isoToSeconds(data.token_next_refresh_time);
      const usable = (data.status == null || data.status === "active") && (expires === null || expires > now);
      const primary = plan ?? total;
      if (primary && (primary.used > 0 || primary.limit > 0)) {
        if (primary.limit > 0 && primary.used >= primary.limit) base.blocked = true;
        const reset =
          usable && plan && plan.limit > 0 && next !== null && next > now && (expires === null || next < expires)
            ? next
            : null;
        windows.push(
          usable && plan && plan.limit > 0
            ? feedWindow(null, Math.min(100, (plan.used / plan.limit) * 100), reset, now, "Plan")
            : valueWindow(plan ? "Plan" : "Quota", compact(Math.max(0, primary.limit - primary.used)) + " cr"),
        );
      }
      for (const [name, p] of [
        ["Top-up", expansion],
        ["Credits", rewards],
        ["Images", images],
      ] satisfies [string, Pool | null][]) {
        if (!p || (!p.limit && !p.used) || windows.length >= 2) continue;
        if (p.limit > 0 && p.used >= p.limit) base.blocked = true;
        windows.push(
          name === "Top-up" && p.limit > 0
            ? feedWindow(null, Math.min(100, (p.used / p.limit) * 100), null, now, name)
            : valueWindow(name, compact(Math.max(0, p.limit - p.used)) + (name === "Images" ? "" : " cr")),
        );
      }
      if (!windows.length) windows.push(valueWindow("Quota", "0 / 0"));
      return [
        {
          ...base,
          blocked: base.blocked || windows.some((w) => (w.used_percent ?? 0) >= 100),
          windows,
        },
      ];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};

class SignIn extends Error {}
