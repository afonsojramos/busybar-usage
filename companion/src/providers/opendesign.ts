import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  type Provider,
} from "./types.ts";

const ID = "opendesign";
const NAME = "OpenDesign";
const fail = (): never => {
  throw new HttpError(NAME, 200);
};
function number(value: unknown, strings = true, negative = false): number {
  const parsed = strings
    ? finiteNumber(value)
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : null;
  if (parsed === null || (!negative && parsed < 0)) return fail();
  return parsed;
}

export const opendesign: Provider = {
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
    const headers: Record<string, string> = { Accept: "application/json" };
    const cookie = await cookieHeader(context, ID, {
      domains: ["amr-api.open-design.ai"],
    });
    if (!cookie) throw new NotConfigured(NAME);
    headers.Cookie = cookie;
    const get = async (
      url: string,
      additions: Record<string, string> = {},
    ): Promise<unknown> => {
      const response = await context.fetch(url, {
        headers: { ...headers, ...additions },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403)
        throw new SignIn();
      if (response.status === 429)
        throw new RateLimited(
          NAME,
          now + retryAfterSeconds(response.headers, 300),
        );
      if (!response.ok) throw new HttpError(NAME, response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError(NAME, response.status);
      }
    };
    try {
      const body = await get(
        "https://amr-api.open-design.ai/api/v1/workspaces/current",
      );
      if (!isRecord(body)) return fail();
      const windows: FeedWindow[] = [];
      const workspace = body.workspaceId;
      if (
        typeof workspace !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(workspace)
      )
        return fail();
      const usage = await get(
        `https://amr-api.open-design.ai/api/v1/workspaces/${workspace}/billing/coding-plan-usage`,
        { "X-Vela-Workspace-Id": workspace },
      );
      if (
        !isRecord(usage) ||
        usage.workspaceId !== workspace ||
        usage.eligible !== true ||
        !Array.isArray(usage.windows)
      )
        return fail();
      for (const seconds of [18000, 604800]) {
        const matches = usage.windows.filter(
          (w) => isRecord(w) && w.durationSeconds === seconds,
        );
        if (!matches.length) continue;
        if (matches.length !== 1 || !isRecord(matches[0])) return fail();
        const item = matches[0];
        const credits = (value: unknown) => {
          if (typeof value === "string" && !/^\d+(?:\.\d+)?$/.test(value))
            return fail();
          const result = number(value);
          return result <= Number.MAX_SAFE_INTEGER ? result : fail();
        };
        const used = credits(item.usedCredits),
          limit = credits(item.limitCredits);
        if (limit <= 0) return fail();
        windows.push(
          feedWindow(
            seconds / 60,
            Math.min(100, (used / limit) * 100),
            isoToSeconds(item.resetsAt),
            now,
          ),
        );
      }
      if (!windows.length) return fail();
      return [
        {
          ...base,
          blocked:
            base.blocked || windows.some((w) => (w.used_percent ?? 0) >= 100),
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
