import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedAccount } from "../feed.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

// Reads the Claude Code sign-in without changing it, as CodexBar does: the token is never
// refreshed or written back, so Claude Code keeps owning it. An expired token shows "sign in"
// until Claude Code next runs and refreshes it.

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
/** The usage endpoint answers only Claude Code's client; this matches its User-Agent format. */
const USER_AGENT = "claude-cli/2.1.0 (external, cli)";

const WINDOWS = [
  { key: "five_hour", minutes: 300 },
  { key: "seven_day", minutes: 10080 },
] as const;

interface Credentials {
  accessToken: string;
  /** Unix milliseconds, or null when unknown. */
  expiresAt: number | null;
  scopes: string[] | null;
}

function configDir(context: Context): string {
  return context.env.CLAUDE_CONFIG_DIR || join(context.home, ".claude");
}

export function parseCredentials(text: string): Credentials | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const oauth = isRecord(json) ? json.claudeAiOauth : null;
  if (!isRecord(oauth) || typeof oauth.accessToken !== "string" || oauth.accessToken === "") return null;
  return {
    accessToken: oauth.accessToken,
    expiresAt: finiteNumber(oauth.expiresAt),
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((s): s is string => typeof s === "string") : null,
  };
}

async function readCredentials(context: Context): Promise<Credentials | null> {
  if (context.platform === "darwin") {
    const keychain = await context.readKeychain(KEYCHAIN_SERVICE);
    const parsed = keychain === null ? null : parseCredentials(keychain);
    if (parsed) return parsed;
  }
  const file = await context.readFile(join(configDir(context), ".credentials.json"));
  return file === null ? null : parseCredentials(file);
}

async function readEmail(context: Context): Promise<string | null> {
  // Claude Code keeps the signed-in account in ~/.claude.json, or in the config directory when it is overridden.
  const path = context.env.CLAUDE_CONFIG_DIR
    ? join(context.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(context.home, ".claude.json");
  const text = await context.readFile(path);
  if (text === null) return null;
  try {
    const json: unknown = JSON.parse(text);
    const account = isRecord(json) ? json.oauthAccount : null;
    return isRecord(account) && typeof account.emailAddress === "string" ? account.emailAddress : null;
  } catch {
    return null;
  }
}

/** Turns the usage response into windows; unknown or missing windows are left out. */
export function parseUsage(json: unknown, nowSeconds: number) {
  if (!isRecord(json)) return null;
  const windows = [];
  for (const { key, minutes } of WINDOWS) {
    const window = json[key];
    if (!isRecord(window)) continue;
    const used = finiteNumber(window.utilization);
    if (used === null) continue;
    windows.push(feedWindow(minutes, used, isoToSeconds(window.resets_at), nowSeconds));
  }
  return windows;
}

export const claude: Provider = {
  id: "claude",
  name: "Claude",
  async fetch(context): Promise<FeedAccount[]> {
    const credentials = await readCredentials(context);
    if (!credentials) throw new NotConfigured("Claude");
    const now = context.now();
    const base = {
      provider: "claude",
      account: accountLabel(await readEmail(context)),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };

    if (credentials.expiresAt !== null && credentials.expiresAt <= now * 1000) {
      return [{ ...base, error: "sign in" }];
    }
    if (credentials.scopes && !credentials.scopes.includes("user:profile")) {
      // Tokens from `claude setup-token` can run models but cannot read usage.
      return [{ ...base, error: "no access" }];
    }

    const response = await context.fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Claude", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Claude", response.status);

    const windows = parseUsage(await response.json(), now);
    if (windows === null) throw new HttpError("Claude", response.status);
    const blocked = windows.some((window) => window.used_percent >= 100);
    return [{ ...base, blocked, windows }];
  },
};
