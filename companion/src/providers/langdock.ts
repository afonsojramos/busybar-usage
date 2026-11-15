import {
  accountLabel,
  feedWindow,
  isRecord,
  isoToSeconds,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "langdock";
const NAME = "Langdock";
const invalid = (): never => {
  throw new HttpError(NAME, 200);
};
const object = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : invalid());
const numeric = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : invalid());
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

async function request(
  context: Context,
  url: string,
  headers: Record<string, string>,
  body?: unknown,
  signal = AbortSignal.timeout(30_000),
): Promise<unknown> {
  const response = await context.fetch(url, {
    method: body === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try {
    return await response.json();
  } catch {
    throw new HttpError(NAME, response.status);
  }
}

export const langdock: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, ID);
    if (entry.cookieSource === "off") throw new NotConfigured(NAME);
    const base: FeedAccount = {
      provider: ID,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(context.now() * 1000).toISOString(),
      windows: [],
    };
    // The shared broker cannot select profiles; require a pinned header to avoid another account.
    if (!text(entry.cookieHeader)) throw new NotConfigured(NAME);
    const cookie = await cookieHeader(context, ID, {
      domains: ["langdock.com", "app.langdock.com"],
      required: ["auth_token"],
    });
    if (!cookie) throw new NotConfigured(NAME);
    try {
      const input = encodeURIComponent(JSON.stringify({ 0: { json: null, meta: { values: ["undefined"], v: 1 } } }));
      const raw = await request(
        context,
        `https://app.langdock.com/api/trpc/usageSettings.getPersonalUsage?batch=1&input=${input}`,
        { Cookie: cookie, Referer: "https://app.langdock.com/settings/account/usage" },
      );
      if (!Array.isArray(raw) || raw.length !== 1) return invalid();
      const envelope = object(raw[0]);
      if (envelope.error !== undefined) {
        const code = object(object(object(envelope.error).json).data).code;
        if (code === "UNAUTHORIZED" || code === "FORBIDDEN") return [{ ...base, error: "sign in" }];
        if (code === "TOO_MANY_REQUESTS") throw new RateLimited(NAME, context.now() + 300);
        return invalid();
      }
      const payload = object(object(object(envelope.result).data).json);
      if (payload.hasIncludedUsageLimits !== undefined && typeof payload.hasIncludedUsageLimits !== "boolean")
        return invalid();
      if (payload.hasIncludedUsageLimits === false || payload.planUsage == null)
        return [{ ...base, windows: [valueWindow("Limits", "none")] }];
      const plan = object(payload.planUsage);
      if (typeof plan.sessionUsageLimitsEnabled !== "boolean") return invalid();
      const reset = (value: unknown): number | null => {
        if (value == null) return null;
        return isoToSeconds(value) ?? invalid();
      };
      const sessionReset = reset(plan.sessionResetsAt),
        weeklyReset = reset(plan.weeklyResetsAt);
      const windows: FeedWindow[] = [];
      if (plan.sessionUsageLimitsEnabled)
        windows.push(feedWindow(300, numeric(plan.sessionUsagePercent), sessionReset, context.now()));
      windows.push(feedWindow(10080, numeric(plan.weeklyUsagePercent), weeklyReset, context.now()));
      return [{ ...base, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100), windows }];
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
