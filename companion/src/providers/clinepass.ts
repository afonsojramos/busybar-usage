import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  type Context,
  type Provider,
  type RequestOptions,
} from "./types.ts";

const ID = "clinepass";

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

async function credential(context: Context): Promise<string | null> {
  const key = await apiKey(context, ID, ["CLINE_API_KEY", "CLINEPASS_API_KEY"]);
  if (key) return key;
  const expand = (path: string) => (path.startsWith("~/") ? `${context.home}/${path.slice(2)}` : path);
  const env = context.env;
  const path =
    env.CLINE_PROVIDER_SETTINGS_PATH ||
    `${env.CLINE_DATA_DIR || `${env.CLINE_DIR || `${context.home}/.cline`}/data`}/settings/providers.json`;
  const text = await context.readFile(expand(path));
  if (!text) return null;
  try {
    const root: unknown = JSON.parse(text);
    const providers = isRecord(root) ? root.providers : null;
    const cline = isRecord(providers) ? providers.cline : null;
    const settings = isRecord(cline) ? cline.settings : null;
    if (!isRecord(settings)) return null;
    const auth = isRecord(settings.auth) ? settings.auth : {};
    const access = typeof auth.accessToken === "string" ? auth.accessToken.trim() : "";
    if (access) return access.startsWith("workos:") ? access : `workos:${access}`;
    return (
      [settings.apiKey, auth.apiKey]
        .find((value): value is string => typeof value === "string" && !!value.trim())
        ?.trim() ?? null
    );
  } catch {
    return null;
  }
}

export const clinepass: Provider = {
  id: ID,
  name: "ClinePass",
  async fetch(context) {
    const key = await credential(context);
    if (!key) throw new NotConfigured(ID);
    try {
      const root = object(await request(context, "https://api.cline.bot/api/v1/users/me/plan/usage-limits", key));
      if (root.success !== true) throw new HttpError(ID, 200);
      const limits = object(root.data).limits;
      if (!Array.isArray(limits)) throw new HttpError(ID, 200);
      const lanes = new Map<number, FeedWindow>();
      for (const raw of limits) {
        const limit = object(raw);
        if (typeof limit.type !== "string") throw new HttpError(ID, 200);
        const minutes = new Map([
          ["five_hour", 300],
          ["weekly", 10080],
          ["monthly", 43200],
        ]).get(limit.type);
        if (!minutes) continue;
        if (typeof limit.percentUsed !== "number" || !Number.isFinite(limit.percentUsed)) throw new HttpError(ID, 200);
        const reset = isoToSeconds(limit.resetsAt);
        if (limit.resetsAt != null && reset === null) throw new HttpError(ID, 200);
        lanes.set(minutes, feedWindow(minutes, Math.min(100, Math.max(0, limit.percentUsed)), reset, context.now()));
      }
      return finish(
        context,
        [...lanes.values()].sort((a, b) => number(a.minutes) - number(b.minutes)),
      );
    } catch (error) {
      return signIn(context, error);
    }
  },
};
