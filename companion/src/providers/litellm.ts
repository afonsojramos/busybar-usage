import { accountLabel, feedWindow, isoToSeconds, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "litellm";
const NAME = "LiteLLM";

class SignIn extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(NAME, 200);
  return value;
}

function number(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(NAME, 200);
  return value;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new HttpError(NAME, 200);
  return value.trim() || null;
}

function privateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "[::1]" || /^\[f[cd][0-9a-f]{2}:/i.test(host) || /^\[fe[89ab][0-9a-f]:/i.test(host)) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  );
}

function endpoint(raw: string | null, policy: "private" | "loopback" | "https" = "private"): URL {
  if (!raw) throw new NotConfigured(NAME);
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new NotConfigured(NAME);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname.startsWith("127.");
  const http =
    url.protocol === "http:" && (policy === "private" ? privateHost(url.hostname) : policy === "loopback" && loopback);
  if ((url.protocol !== "https:" && !http) || url.username || url.password) throw new NotConfigured(NAME);
  return url;
}

async function request(context: Context, url: URL, key: string | null, optional = false): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const response = await context.fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (optional && [401, 403, 404].includes(response.status)) return undefined;
  if (response.status === 401 || response.status === 403) throw new SignIn();
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try {
    return await response.json();
  } catch {
    throw new HttpError(NAME, response.status);
  }
}

function money(value: number): string {
  const compact =
    Math.abs(value) >= 1e6
      ? `${(value / 1e6).toPrecision(3)}m`
      : Math.abs(value) >= 1e4
        ? `${(value / 1e3).toPrecision(3)}k`
        : value.toFixed(2);
  return `$${compact}`.slice(0, 12);
}

export const litellm: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, ID, ["LITELLM_API_KEY"]);
    if (!key) throw new NotConfigured(NAME);
    const entry = await providerEntry(context, ID);
    const now = context.now();
    const base: FeedAccount = {
      provider: ID,
      provider_name: NAME,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    try {
      const url = endpoint(text(context.env.LITELLM_BASE_URL) ?? text(entry.enterpriseHost));
      const path = url.pathname.replace(/\/+$/, "").replace(/\/(?:v1|%76%31)$/i, "");
      const get = async (route: string, query: Record<string, string> | null = null, optional = false) => {
        const next = new URL(url);
        next.pathname = path + "/" + route;
        if (query) next.search = new URLSearchParams(query).toString();
        return request(context, next, key, optional);
      };
      const info = await get("key/info", null, true);
      if (info === undefined) {
        const end = new Date(now * 1000).toISOString().slice(0, 10);
        const query = { start_date: end.slice(0, 7) + "-01", end_date: end };
        let rows = await get("key/spend/report", query, true);
        if (rows === undefined) rows = await get("user/spend/report", query);
        if (!Array.isArray(rows) || !rows.length) throw new HttpError(NAME, 200);
        let spend = 0;
        for (const row of rows) {
          const cost = object(row).total_cost;
          if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) throw new HttpError(NAME, 200);
          spend += cost;
        }
        if (!Number.isFinite(spend)) throw new HttpError(NAME, 200);
        return [{ ...base, windows: [valueWindow("spend", money(spend))] }];
      }
      const keyInfo = object(object(info).info);
      const userID = text(keyInfo.user_id);
      const teamID = text(keyInfo.team_id);
      if (!userID && !teamID) throw new HttpError(NAME, 200);
      type Budget = { used: number; limit: number; reset: number | null; minutes: number | null; label: string };
      const budget = (raw: unknown, label: string): Budget => {
        const row = object(raw);
        const durations: Record<string, number> = { "1h": 60, "1d": 1440, "7d": 10080, "30d": 43200, "1mo": 43200 };
        const duration = text(row.budget_duration) ?? "";
        return {
          minutes: Object.hasOwn(durations, duration) ? durations[duration] : null,
          used: number(row.spend),
          limit: Math.max(0, number(row.max_budget)),
          reset: isoToSeconds(text(row.budget_reset_at)),
          label,
        };
      };
      const matchingID = (value: unknown, expected: string | null) => {
        const actual = text(value);
        if (actual !== null && actual !== expected) throw new HttpError(NAME, 200);
      };
      let email: string | null = null;
      let personal: Budget | null = null;
      let team: Budget | null = null;
      if (userID) {
        const root = object(await get("user/info", { user_id: userID }));
        const user = object(root.user_info);
        matchingID(user.user_id ?? root.user_id, userID);
        const metadata = user.metadata == null ? {} : object(user.metadata);
        email =
          text(user.user_email) ??
          text(user.user_alias) ??
          (typeof metadata.preferred_username === "string" ? text(metadata.preferred_username) : null);
        personal = budget(user, "user");
        if (root.teams != null && !Array.isArray(root.teams)) throw new HttpError(NAME, 200);
        const teams = (Array.isArray(root.teams) ? root.teams : []).map(object);
        for (const row of teams) {
          if (!text(row.team_id)) throw new HttpError(NAME, 200);
          budget(row, "team");
        }
        const selected = teams.find((row) => row.team_id === teamID);
        if (selected) team = budget(selected, "team");
        if (teamID && personal.limit <= 0) {
          // A member limit must be paired with that member's team-scoped spend.
          try {
            const member = (raw: unknown): Record<string, unknown> | undefined =>
              Array.isArray(raw)
                ? raw
                    .map(object)
                    .find((row) => row.user_id === userID && (row.team_id == null || row.team_id === teamID))
                : undefined;
            const mine = member(selected?.team_memberships);
            let table = object(mine?.litellm_budget_table ?? {});
            let spent = mine?.spend == null ? null : number(mine.spend);
            if (table.max_budget == null || spent === null) {
              const reply = await get("team/info", { team_id: teamID }, true);
              if (reply !== undefined) {
                const root = object(reply);
                const info = object(root.team_info);
                matchingID(info.team_id ?? root.team_id, teamID);
                const fallback = member(info.team_memberships ?? root.team_memberships);
                if (table.max_budget == null) {
                  table = object(fallback?.litellm_budget_table ?? {});
                  if (table.max_budget == null) table = object(info.team_member_budget_table ?? {});
                }
                if (spent === null && fallback?.spend != null) spent = number(fallback.spend);
              }
            }
            if (number(table.max_budget) > 0 && spent !== null) {
              personal = budget(
                { spend: spent, max_budget: table.max_budget, budget_reset_at: table.budget_reset_at },
                "member",
              );
            }
          } catch (error) {
            if (error instanceof RateLimited || error instanceof SignIn) throw error;
            if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
          }
        }
      } else {
        const root = object(await get("team/info", { team_id: teamID ?? "" }));
        const info = object(root.team_info);
        matchingID(info.team_id ?? root.team_id, teamID);
        team = budget(info, "team");
      }
      const budgets = [personal, team].filter((value): value is Budget => value !== null);
      const windows = budgets
        .filter((budget) => budget.limit > 0)
        .map((budget) =>
          feedWindow(
            budget.minutes,
            (budget.used / budget.limit) * 100,
            budget.reset,
            now,
            budget.minutes === null ? budget.label : undefined,
          ),
        );
      windows.sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
      const blocked = windows.some((window) => (window.used_percent ?? 0) >= 100);
      if (windows.length < 2) {
        const unmetered = budgets.find((budget) => budget.limit <= 0);
        if (unmetered) windows.push(valueWindow("spend", money(unmetered.used)));
      }
      const activityEnabled =
        context.env.LITELLM_MODEL_USAGE_ENABLED === "true" ||
        (context.env.LITELLM_MODEL_USAGE_ENABLED === undefined && entry.litellmModelUsageEnabled === true);
      if (userID && activityEnabled) {
        // Optional history cannot discard successfully fetched budgets.
        try {
          const end = new Date(now * 1000).toISOString().slice(0, 10);
          const start = new Date((now - 29 * 86400) * 1000).toISOString().slice(0, 10);
          let tokens = 0;
          for (let page = 1; page <= 3; page++) {
            const root = object(
              await get("user/daily/activity", {
                user_id: userID,
                start_date: start,
                end_date: end,
                page: String(page),
                page_size: "1000",
              }),
            );
            if (!Array.isArray(root.results) || root.results.length > 31) throw new HttpError(NAME, 200);
            for (const raw of root.results) {
              const row = object(raw);
              const day = text(row.date);
              if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day < start || day > end) throw new HttpError(NAME, 200);
              for (const rawModel of Object.values(object(object(row.breakdown).models))) {
                const model = object(rawModel);
                const metrics = object(model.metrics ?? model);
                for (const field of ["prompt_tokens", "completion_tokens", "total_tokens", "api_requests"]) {
                  if (
                    typeof metrics[field] !== "number" ||
                    !Number.isSafeInteger(metrics[field]) ||
                    number(metrics[field]) < 0
                  ) {
                    throw new HttpError(NAME, 200);
                  }
                }
                tokens += number(metrics.total_tokens);
              }
            }
            if (!Number.isSafeInteger(tokens)) throw new HttpError(NAME, 200);
            const metadata = object(root.metadata ?? {});
            if (metadata.page != null && number(metadata.page) !== page) throw new HttpError(NAME, 200);
            const pages = number(metadata.total_pages, 1);
            if (
              !Number.isSafeInteger(pages) ||
              pages < 0 ||
              (metadata.has_more != null && typeof metadata.has_more !== "boolean")
            )
              throw new HttpError(NAME, 200);
            if (metadata.has_more !== true && page >= pages) {
              if (windows.length < 2)
                windows.push(
                  valueWindow(
                    "tokens",
                    new Intl.NumberFormat("en", { notation: "compact" }).format(tokens).slice(0, 12),
                  ),
                );
              break;
            }
            if (page === 3) throw new HttpError(NAME, 200);
          }
        } catch (error) {
          if (error instanceof RateLimited || error instanceof SignIn) throw error;
          if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
        }
      }
      return [{ ...base, account: accountLabel(email), windows: windows.slice(0, 2), blocked }];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
