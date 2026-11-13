import { delimiter, join, resolve } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { jwtPayload } from "./codex.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ROOT = "https://cloudcode-pa.googleapis.com/v1internal:";

async function oauthClient(context: Context): Promise<{ id: string; secret: string } | null> {
  const id = context.env.GEMINI_OAUTH_CLIENT_ID?.trim();
  const secret = context.env.GEMINI_OAUTH_CLIENT_SECRET?.trim();
  if (id && secret) return { id, secret };
  const suffix = "@google/gemini-cli-core/dist/src/code_assist/oauth2.js";
  const prefixes = ["/opt/homebrew", "/usr/local", join(context.home, ".npm-global")];
  const paths = [context.env.GEMINI_OAUTH2_JS_PATH];
  for (const bin of (context.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const prefix = resolve(bin, "..");
    paths.push(join(prefix, "lib/node_modules", suffix));
    paths.push(join(prefix, "lib/node_modules/@google/gemini-cli/node_modules", suffix));
    paths.push(join(prefix, "node_modules", suffix));
  }
  for (const prefix of prefixes) {
    paths.push(join(prefix, "lib/node_modules", suffix));
    paths.push(join(prefix, "lib/node_modules/@google/gemini-cli/node_modules", suffix));
    paths.push(join(prefix, "opt/gemini-cli/libexec/lib/node_modules/@google/gemini-cli/node_modules", suffix));
  }
  for (const path of paths) {
    if (!path) continue;
    const source = await context.readFile(path);
    if (!source) continue;
    const id = /\bOAUTH_CLIENT_ID\s*=\s*['"]([\w.-]+)['"]\s*;/.exec(source)?.[1];
    const secret = /\bOAUTH_CLIENT_SECRET\s*=\s*['"]([\w-]+)['"]\s*;/.exec(source)?.[1];
    if (id && secret) return { id, secret };
  }
  return null;
}

export function parseUsage(body: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(body) || !Array.isArray(body.buckets) || body.buckets.length === 0) return null;
  const tiers = new Map<string, { fraction: number; reset: number | null }>();
  for (const bucket of body.buckets) {
    if (!isRecord(bucket) || typeof bucket.modelId !== "string") continue;
    const model = bucket.modelId.toLowerCase();
    const tier = model.includes("pro") ? "Pro" : model.includes("flash-lite") ? "Lite" : model.includes("flash") ? "Flash" : null;
    const fraction = finiteNumber(bucket.remainingFraction);
    if (!tier || fraction === null) continue;
    const existing = tiers.get(tier);
    if (!existing || fraction < existing.fraction) tiers.set(tier, { fraction, reset: isoToSeconds(bucket.resetTime) });
  }
  if (tiers.size === 0) return null;
  return ["Pro", "Flash", "Lite"].flatMap((name) => {
    const tier = tiers.get(name);
    return tier ? [feedWindow(1440, (1 - tier.fraction) * 100, tier.reset, now, name)] : [];
  }).slice(0, 2);
}

export const gemini: Provider = {
  id: "gemini",
  name: "Gemini",
  async fetch(context): Promise<FeedAccount[]> {
    const file = await context.readFile(join(context.home, ".gemini/oauth_creds.json"));
    let credentials: unknown;
    try { credentials = file === null ? null : JSON.parse(file); } catch { credentials = null; }
    if (!isRecord(credentials)) throw new NotConfigured("Gemini");
    let token = typeof credentials.access_token === "string" ? credentials.access_token : "";
    const refresh = typeof credentials.refresh_token === "string" ? credentials.refresh_token : "";
    if (!token && !refresh) throw new NotConfigured("Gemini");
    const now = context.now();
    const claims = typeof credentials.id_token === "string" ? jwtPayload(credentials.id_token) : null;
    const base: FeedAccount = {
      provider: "gemini", account: accountLabel(typeof claims?.email === "string" ? claims.email : null),
      blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    async function request(url: string, init: RequestInit): Promise<Record<string, unknown>> {
      const response = await context.fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      if (response.status === 429) throw new RateLimited("Gemini", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Gemini", response.status);
      let body: unknown;
      try { body = await response.json(); } catch { throw new HttpError("Gemini", response.status); }
      if (!isRecord(body)) throw new HttpError("Gemini", response.status);
      return body;
    }
    try {
      const expiry = finiteNumber(credentials.expiry_date);
      if (!token || (expiry !== null && expiry <= now * 1000)) {
        const client = refresh ? await oauthClient(context) : null;
        if (!client) return [{ ...base, error: "sign in" }];
        // Google refresh tokens do not rotate; keep refreshed access tokens in memory only.
        const refreshed = await request("https://oauth2.googleapis.com/token", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: client.id, client_secret: client.secret, refresh_token: refresh, grant_type: "refresh_token" }).toString(),
        });
        if (typeof refreshed.access_token !== "string" || !refreshed.access_token) throw new HttpError("Gemini", 200);
        token = refreshed.access_token;
      }
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const assist = await request(`${ROOT}loadCodeAssist`, {
        method: "POST", headers, body: JSON.stringify({ metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" } }),
      });
      const project = assist.cloudaicompanionProject;
      let projectId = typeof project === "string" ? project : isRecord(project) ? project.id ?? project.projectId : null;
      if (typeof projectId !== "string" || !projectId.trim()) {
        const projects = await request("https://cloudresourcemanager.googleapis.com/v1/projects", { headers: { Authorization: `Bearer ${token}` } });
        projectId = Array.isArray(projects.projects) ? projects.projects.find((p: unknown) => isRecord(p) && typeof p.projectId === "string" && (p.projectId.startsWith("gen-lang-client") || (isRecord(p.labels) && "generative-language" in p.labels)))?.projectId : null;
      }
      const body = await request(`${ROOT}retrieveUserQuota`, {
        method: "POST", headers, body: JSON.stringify(typeof projectId === "string" ? { project: projectId.trim() } : {}),
      });
      const windows = parseUsage(body, now);
      if (windows === null) throw new HttpError("Gemini", 200);
      return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
