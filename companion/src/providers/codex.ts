import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

// Reads the Codex CLI sign-in from auth.json without changing it. Refresh tokens rotate, so
// refreshing here would sign the Codex CLI out; an expired token shows "sign in" until Codex
// next runs and refreshes it.

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

interface Credentials {
  accessToken: string;
  accountId: string | null;
  email: string | null;
  /** Unix seconds from the access token, or null when it cannot be read. */
  expiresAt: number | null;
}

/** The payload of a JWT, without verifying it: only used to read the expiry and email shown to the user. */
export function jwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return isRecord(json) ? json : null;
  } catch {
    return null;
  }
}

function emailFrom(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null;
  if (typeof payload.email === "string") return payload.email;
  const profile = payload["https://api.openai.com/profile"];
  return isRecord(profile) && typeof profile.email === "string" ? profile.email : null;
}

export function parseAuthFile(text: string): Credentials | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const tokens = isRecord(json) ? json.tokens : null;
  if (!isRecord(tokens)) return null;
  const accessToken = tokens.access_token ?? tokens.accessToken;
  if (typeof accessToken !== "string" || accessToken === "") return null;
  const accountId = tokens.account_id ?? tokens.accountId;
  const idToken = tokens.id_token ?? tokens.idToken;
  const access = jwtPayload(accessToken);
  return {
    accessToken,
    accountId: typeof accountId === "string" && accountId !== "" ? accountId : null,
    email: emailFrom(typeof idToken === "string" ? jwtPayload(idToken) : null) ?? emailFrom(access),
    expiresAt: finiteNumber(access?.exp),
  };
}

function parseWindow(value: unknown, nowSeconds: number): FeedWindow | null {
  if (!isRecord(value)) return null;
  const used = finiteNumber(value.used_percent);
  const seconds = finiteNumber(value.limit_window_seconds);
  if (used === null || seconds === null || seconds <= 0) return null;
  return feedWindow(Math.round(seconds / 60), used, finiteNumber(value.reset_at), nowSeconds);
}

/** Turns the wham/usage response into windows, shortest first. */
export function parseUsage(json: unknown, nowSeconds: number): FeedWindow[] | null {
  if (!isRecord(json)) return null;
  const limits = json.rate_limit;
  if (!isRecord(limits)) return [];
  return [parseWindow(limits.primary_window, nowSeconds), parseWindow(limits.secondary_window, nowSeconds)]
    .filter((window): window is FeedWindow => window !== null)
    .sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
}

export const codex: Provider = {
  id: "codex",
  name: "Codex",
  async fetch(context): Promise<FeedAccount[]> {
    const home = context.env.CODEX_HOME || join(context.home, ".codex");
    const file = await context.readFile(join(home, "auth.json"));
    const credentials = file === null ? null : parseAuthFile(file);
    if (!credentials) throw new NotConfigured("Codex");
    const now = context.now();
    const base = {
      provider: "codex",
      account: accountLabel(credentials.email),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    if (credentials.expiresAt !== null && credentials.expiresAt <= now) return [{ ...base, error: "sign in" }];

    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "User-Agent": "busybar-usage",
    };
    if (credentials.accountId) headers["ChatGPT-Account-Id"] = credentials.accountId;
    const response = await context.fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(30_000) });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Codex", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Codex", response.status);

    const windows = parseUsage(await response.json(), now);
    if (windows === null) throw new HttpError("Codex", response.status);
    return [{ ...base, blocked: windows.some((window) => (window.used_percent ?? 0) >= 100), windows }];
  },
};
