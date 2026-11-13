import { isAbsolute, join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { jwtPayload } from "./codex.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

function object(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try { const parsed: unknown = JSON.parse(text); return isRecord(parsed) ? parsed : null; } catch { return null; }
}

export function parseAntigravitySummary(root: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(root)) return null;
  if (root.code !== undefined && ![0, "0", "ok", "success"].includes(typeof root.code === "string" ? root.code.toLowerCase() : Number(root.code))) return null;
  let payload = isRecord(root.response) ? root.response : isRecord(root.summary) ? root.summary : root;
  if (root.status !== undefined) {
    if (root.status !== "SUCCESS" || !isRecord(root.command) || root.command.name !== "usage" || !isRecord(root.command.data)) return null;
    payload = root.command.data;
  }
  if (!Array.isArray(payload.groups)) return null;
  const windows: FeedWindow[] = [];
  for (const group of payload.groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
    const family = /gemini/i.test(String(group.displayName ?? group.display_name ?? group.name ?? "")) ? "gem" : "claude";
    for (const bucket of group.buckets) {
      if (!isRecord(bucket) || bucket.disabled === true) continue;
      const remaining = isRecord(bucket.remaining) ? bucket.remaining : null;
      const fraction = finiteNumber(bucket.remainingFraction ?? bucket.remaining_fraction ?? remaining?.remainingFraction
        ?? (remaining?.case === "remainingFraction" ? remaining.value : null));
      if (fraction === null || fraction < 0 || fraction > 1) continue;
      const cadence = bucket.window;
      const minutes = cadence === "5h" ? 300 : cadence === "weekly" ? 10080 : null;
      const name = `${family}${minutes === 300 ? '5h' : minutes === 10080 ? '7d' : ''}`;
      windows.push(feedWindow(minutes, (1 - fraction) * 100, isoToSeconds(bucket.resetTime ?? bucket.reset_time), now, name));
    }
  }
  const cadences = new Map<number, FeedWindow>();
  for (const window of windows) {
    if (window.minutes === null) continue;
    const previous = cadences.get(window.minutes);
    if (!previous || (window.used_percent ?? 0) > (previous.used_percent ?? 0)) {
      cadences.set(window.minutes, { ...window, name: window.minutes === 300 ? "5h" : "7d" });
    }
  }
  return cadences.size ? [...cadences.values()].sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0))
    : windows.length ? windows : null;
}

export function parseAntigravityModels(root: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(root)) return null;
  const rows = isRecord(root.models) ? Object.entries(root.models).map(([id, model]) => ({ id, model }))
    : Array.isArray(root.buckets) ? root.buckets.filter(isRecord).map(model => ({ id: String(model.modelId ?? ""), model })) : [];
  const pools = new Map<string, FeedWindow>();
  for (const row of rows) {
    if (!isRecord(row.model)) continue;
    const quota = isRecord(row.model.quotaInfo) ? row.model.quotaInfo : row.model;
    const remaining = finiteNumber(quota.remainingFraction);
    if (remaining === null || remaining < 0 || remaining > 1) continue;
    const family = /gemini/i.test(row.id) ? "gemini" : /claude|gpt/i.test(row.id) ? "claude" : null;
    if (!family || /image|lite|autocomplete/i.test(row.id)) continue;
    const window = feedWindow(null, (1 - remaining) * 100, isoToSeconds(quota.resetTime), now, family);
    if ((pools.get(family)?.used_percent ?? -1) < (window.used_percent ?? 0)) pools.set(family, window);
  }
  return pools.size ? [...pools.values()] : null;
}

export const antigravity: Provider = {
  id: "antigravity", name: "Antigravity",
  async fetch(context) {
    const now = context.now();
    const configured = await apiKey(context, "antigravity", ["ANTIGRAVITY_OAUTH_CREDENTIALS_JSON"]);
    const raw = configured ?? await context.readFile(join(context.home, ".codexbar/antigravity/oauth_creds.json"));
    const credentials = object(raw);
    const claims = typeof credentials?.idToken === "string" ? jwtPayload(credentials.idToken) : null;
    const email = typeof claims?.email === "string" ? claims.email : typeof credentials?.email === "string" ? credentials.email : null;
    const base = { provider: "antigravity", account: accountLabel(email), observed_at: new Date(now * 1000).toISOString(), blocked: false, windows: [] };
    const finish = (windows: FeedWindow[]) => [{ ...base, windows: windows.slice(0, 2), blocked: windows.some(w => (w.used_percent ?? 0) >= 100) }];
    let token = typeof credentials?.accessToken === "string" ? credentials.accessToken : null;
    async function request(url: string, body: unknown, headers: Record<string, string>): Promise<unknown> {
      const response = await context.fetch(url, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000), redirect: "error" });
      if (response.status === 429) throw new RateLimited("Antigravity", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Antigravity", response.status);
      try { return await response.json(); } catch { throw new HttpError("Antigravity", response.status); }
    }
    if (token && credentials) {
      try {
        const expiry = finiteNumber(credentials.expiryDateMilliseconds);
        if (expiry !== null && expiry <= (now + 60) * 1000) {
          const clientID = credentials.clientID ?? context.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
          const clientSecret = credentials.clientSecret ?? context.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
          if (typeof credentials.refreshToken !== "string" || typeof clientID !== "string" || typeof clientSecret !== "string") return [{ ...base, error: "sign in" }];
          // Google refresh tokens do not rotate; refreshed access stays in memory only.
          const refreshed = await request("https://oauth2.googleapis.com/token", new URLSearchParams({
            grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: clientID, client_secret: clientSecret,
          }).toString(), { "Content-Type": "application/x-www-form-urlencoded" });
          if (!isRecord(refreshed) || typeof refreshed.access_token !== "string" || !refreshed.access_token) throw new HttpError("Antigravity", 200);
          token = refreshed.access_token;
        }
        const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
          "User-Agent": `antigravity/hub/2.9.1 ${context.platform === "linux" ? "linux" : "darwin"}/${process.arch === "arm64" ? "arm64" : "amd64"}` };
        const assist = await request("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
          metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" },
        }, headers);
        if (!isRecord(assist)) throw new HttpError("Antigravity", 200);
        const project = credentials.projectID ?? (typeof assist.cloudaicompanionProject === "string" ? assist.cloudaicompanionProject
          : isRecord(assist.cloudaicompanionProject) ? assist.cloudaicompanionProject.id : null);
        const body = typeof project === "string" && project.trim() ? { project } : {};
        const summary = await request("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", body, headers);
        let windows = parseAntigravitySummary(summary, now);
        if (windows) return finish(windows);
        const models = await request("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", body, headers);
        windows = parseAntigravityModels(models, now);
        // Some accounts get placeholder full quotas; verify them against the quota buckets.
        if (windows && windows.every(w => (w.used_percent ?? 0) === 0)) {
          windows = parseAntigravityModels(await request("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", body, headers), now);
        }
        if (!windows) throw new HttpError("Antigravity", 200);
        return finish(windows);
      } catch (error) {
        if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
        throw error;
      }
    }
    if (raw !== null) throw new NotConfigured("Antigravity");
    const override = context.env.ANTIGRAVITY_CLI_PATH;
    let binary: string | null = null;
    if (override !== undefined) {
      if (!override.trim() || !isAbsolute(override)) throw new NotConfigured("Antigravity");
      binary = override;
    } else {
      for (const directory of (context.env.PATH ?? `${join(context.home, ".local/bin")}:/opt/homebrew/bin:/usr/local/bin`).split(":")) {
        if (!isAbsolute(directory)) continue;
        if ((await context.listDir(directory))?.includes("agy")) { binary = join(directory, "agy"); break; }
      }
    }
    if (!binary) throw new NotConfigured("Antigravity");
    // An absolute native CLI and empty PATH prevent print-mode sign-in from launching a browser.
    const env = { AGY_CLI_DISABLE_AUTO_UPDATE: "true", BROWSER: "/usr/bin/false", PATH: "" };
    const version = await context.run(binary, ["--version"], { timeoutMs: 3_000, env });
    const parts = version?.code === 0 ? version.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/) : null;
    if (!parts || (Number(parts[1]) === 1 && Number(parts[2]) === 1 && Number(parts[3]) < 11)
      || (Number(parts[1]) === 1 && Number(parts[2]) < 1) || Number(parts[1]) < 1) throw new NotConfigured("Antigravity");
    const result = await context.run(binary, ["-p", "/usage", "--output-format", "json", "--print-timeout", "90s"], { timeoutMs: 95_000, env });
    if (!result) throw new NotConfigured("Antigravity");
    if (/select\s+login\s+method|you\s+are\s+not\s+logged\s+into\s+antigravity|keyring\s*auth\s*:\s*timed\s+out/i.test(result.stdout + result.stderr)) return [{ ...base, error: "sign in" }];
    const windows = result.code === 0 ? parseAntigravitySummary(object(result.stdout), now) : null;
    if (!windows) throw new HttpError("Antigravity", 502);
    return finish(windows);
  },
};
