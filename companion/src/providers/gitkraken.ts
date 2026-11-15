import {
  accountLabel,
  feedWindow,
  isoToSeconds,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const ID = "gitkraken";
const NAME = "GitKraken";
const fail = (): never => {
  throw new HttpError(NAME, 200);
};

export const gitkraken: Provider = {
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
    const key = await apiKey(context, ID, ["GITKRAKEN_API_TOKEN"]);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!key) throw new NotConfigured(NAME);
    headers.Authorization = `Bearer ${key}`;
    const entry = await providerEntry(context, ID);
    const organization = String(entry.workspaceID ?? context.env.GITKRAKEN_ORG_ID ?? "").trim();
    if (!/^[\x21-\x7e]{1,16384}$/.test(key) || (organization && !/^[\x21-\x7e]{1,256}$/.test(organization)))
      return [{ ...base, error: "sign in" }];
    headers["Client-Name"] = "CodexBar";
    headers["Client-Version"] = "0.0.0";
    headers["User-Agent"] = "CodexBar";
    if (organization) headers["gk-org-id"] = organization;
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
      const body = await get("https://api.gitkraken.dev/v1/ai-tasks/usage");
      if (!isRecord(body)) return fail();
      const windows: FeedWindow[] = [];
      const data = body.data;
      if (body.error != null || !isRecord(data)) return fail();
      const quota = (value: unknown): { used: number; limit: number } | null => {
        if (
          !isRecord(value) ||
          typeof value.used !== "number" ||
          typeof value.limit !== "number" ||
          !Number.isFinite(value.used) ||
          !Number.isFinite(value.limit) ||
          value.used < 0 ||
          (value.limit < 0 && value.limit !== -1) ||
          (value.limit > 0 && !Number.isFinite((value.used / value.limit) * 100))
        )
          return null;
        return { used: value.used, limit: value.limit };
      };
      const personal = quota(data);
      const reset = isoToSeconds(data.resetsOn);
      if (
        !personal ||
        reset === null ||
        typeof data.resetsOn !== "string" ||
        !/T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.resetsOn)
      )
        return fail();
      for (const [name, q] of [
        ["Personal", personal],
        ["Pool", quota(data.organization)],
      ] satisfies [string, { used: number; limit: number } | null][]) {
        if (!q) continue;
        if (q.limit === 0) base.blocked = true;
        windows.push(
          q.limit > 0
            ? feedWindow(10080, Math.min(100, (q.used / q.limit) * 100), reset, now, name)
            : valueWindow(name, q.limit === -1 ? "Unlimited" : "No allowance"),
        );
      }
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
