import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { jwtPayload } from "./codex.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const NAME = "Vertex AI";
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
class SignIn extends Error {}

async function responseJson(context: Context, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await context.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (response.status === 401 || response.status === 403) throw new SignIn();
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) throw new HttpError(NAME, response.status);
  return body;
}

interface Quota { metric: string; limit: string; location: string; value: number }
function aggregate(series: unknown[]): Quota[] {
  const quotas = new Map<string, Quota>();
  for (const item of series) {
    if (!isRecord(item) || !isRecord(item.metric) || !isRecord(item.resource) || !Array.isArray(item.points)) {
      throw new HttpError(NAME, 200);
    }
    const metric = isRecord(item.metric.labels) ? item.metric.labels : {};
    const resource = isRecord(item.resource.labels) ? item.resource.labels : {};
    const quotaMetric = text(metric.quota_metric) ?? text(resource.quota_id);
    if (!quotaMetric) continue;
    const limit = text(metric.limit_name) ?? "";
    const location = text(resource.location) ?? "global";
    let value: number | null = null;
    for (const point of item.points) {
      if (!isRecord(point) || !isRecord(point.value)) throw new HttpError(NAME, 200);
      const number = finiteNumber(point.value.doubleValue) ?? finiteNumber(point.value.int64Value);
      if (number !== null) value = Math.max(value ?? 0, number);
    }
    if (value === null) continue;
    const key = JSON.stringify([quotaMetric, limit, location]);
    quotas.set(key, { metric: quotaMetric, limit, location, value: Math.max(quotas.get(key)?.value ?? 0, value) });
  }
  return [...quotas.values()];
}

export function quotaPercent(usage: unknown[], limits: unknown[]): number | null {
  const used = aggregate(usage);
  const available = aggregate(limits);
  let percent: number | null = null;
  for (const quota of used) {
    let match = available.find((limit) => limit.metric === quota.metric && limit.limit === quota.limit &&
      limit.location === quota.location && limit.value > 0);
    if (!match && quota.limit === "") {
      const candidates = available.filter((limit) => limit.metric === quota.metric &&
        limit.location === quota.location && limit.value > 0);
      if (candidates.length === 1) match = candidates[0];
    }
    if (match) percent = Math.max(percent ?? 0, quota.value / match.value * 100);
  }
  if (percent !== null && !Number.isFinite(percent)) throw new HttpError(NAME, 200);
  return percent;
}

async function timeSeries(context: Context, project: string, token: string, kind: "allocation/usage" | "limit") {
  const series: unknown[] = [];
  const seen = new Set<string>();
  let pageToken: string | null = null;
  for (let page = 0; page < 100; page++) {
    const url = new URL(`https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(project)}/timeSeries`);
    url.searchParams.set("filter", `metric.type="serviceruntime.googleapis.com/quota/${kind}" AND resource.type="consumer_quota" AND resource.label.service="aiplatform.googleapis.com"`);
    url.searchParams.set("interval.startTime", new Date((context.now() - 86400) * 1000).toISOString());
    url.searchParams.set("interval.endTime", new Date(context.now() * 1000).toISOString());
    url.searchParams.set("aggregation.alignmentPeriod", "3600s");
    url.searchParams.set("aggregation.perSeriesAligner", "ALIGN_MAX");
    url.searchParams.set("view", "FULL");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const body = await responseJson(context, url.href, { headers: { Authorization: `Bearer ${token}` } });
    if (body.timeSeries !== undefined && body.timeSeries !== null && !Array.isArray(body.timeSeries)) throw new HttpError(NAME, 200);
    series.push(...(Array.isArray(body.timeSeries) ? body.timeSeries : []));
    if (body.nextPageToken !== undefined && body.nextPageToken !== null && typeof body.nextPageToken !== "string") throw new HttpError(NAME, 200);
    pageToken = text(body.nextPageToken);
    if (!pageToken || seen.has(pageToken)) return series;
    seen.add(pageToken);
  }
  throw new HttpError(NAME, 200);
}

function vertexMetadata(value: Record<string, unknown>, depth = 0): boolean {
  if (depth > 20) return false;
  return Object.entries(value).some(([key, entry]) => {
    if (/vertex|gcp/i.test(key)) return true;
    if (["provider", "platform", "backend", "api_provider", "apiprovider", "api_type", "apitype", "source", "vendor", "client"].includes(key.toLowerCase()) &&
      typeof entry === "string" && /vertex/i.test(entry)) return true;
    if (isRecord(entry)) return vertexMetadata(entry, depth + 1);
    return Array.isArray(entry) && entry.some((child) => isRecord(child) && vertexMetadata(child, depth + 1));
  });
}

// Local transcripts supply token totals, without guessing model prices or writing scanner caches.
async function localTokens(context: Context): Promise<number | null> {
  const root = join(context.env.CLAUDE_CONFIG_DIR || join(context.home, ".claude"), "projects");
  const pending = [root];
  if (!context.env.CLAUDE_CONFIG_DIR) {
    pending.unshift(join(context.home, ".config", "claude", "projects"));
    const desktop = join(context.home, "Library", "Application Support", "Claude");
    const queue = ["local-agent-mode-sessions", "claude-code-sessions"].map((name) => ({ path: join(desktop, name), depth: 0 }));
    const skipped = new Set([".build", ".git", "build", "DerivedData", "node_modules", "outputs", "target"]);
    for (let index = 0; index < queue.length; index++) {
      if (queue.length > 10000) return null;
      const item = queue[index];
      pending.push(join(item.path, ".claude", "projects"), join(item.path, "audit.jsonl"));
      if (item.depth >= 4) continue;
      for (const name of await context.listDir(item.path) ?? []) {
        if (!skipped.has(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")) {
          queue.push({ path: join(item.path, name), depth: item.depth + 1 });
        }
      }
    }
  }
  const swaps = [join(context.home, ".claude-swap-backup", "sessions")];
  if (context.platform === "linux") swaps.push(join(context.env.XDG_DATA_HOME || join(context.home, ".local", "share"), "claude-swap", "sessions"));
  for (const swap of swaps) {
    for (const slot of await context.listDir(swap) ?? []) {
      if (/^[1-9]\d*-/.test(slot) && !slot.includes("/") && !slot.includes("\\")) pending.push(join(swap, slot, "projects"));
    }
  }
  const seen = new Set<string>();
  const rows = new Map<string, { tokens: number; incomplete: boolean }>();
  let anonymous = 0;
  const since = context.now() - 30 * 86400;
  for (let count = 0; pending.length > 0; count++) {
    // Refuse a partial total if the source exceeds the scan budget.
    if (count >= 10000) return null;
    const path = pending.pop();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (!path.endsWith(".jsonl")) {
      for (const name of await context.listDir(path) ?? []) {
        if (name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\")) pending.push(join(path, name));
      }
      continue;
    }
    const content = await context.readFile(path);
    if (!content) continue;
    for (const line of content.split("\n")) {
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      if (!isRecord(row) || row.type !== "assistant" || !isRecord(row.message)) continue;
      const message = row.message;
      const timestamp = isoToSeconds(row.timestamp);
      if (timestamp === null || timestamp < since || timestamp > context.now() || !isRecord(message.usage)) continue;
      const model = text(message.model);
      if (!model) continue;
      if (!(text(message.id)?.includes("_vrtx_") || text(row.requestId)?.includes("_vrtx_") ||
        (model.startsWith("claude-") && model.includes("@")) || vertexMetadata(row))) continue;
      const usage = message.usage;
      const tokens = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
        .reduce((sum, key) => sum + Math.max(0, finiteNumber(usage[key]) ?? 0), 0);
      if (tokens <= 0) continue;
      const incomplete = message.stop_reason === null && (finiteNumber(usage.input_tokens) ?? 0) > 0 &&
        (finiteNumber(usage.output_tokens) ?? 0) === 0 && usage.cache_read_input_tokens === undefined &&
        usage.cache_creation_input_tokens === undefined;
      const id = text(message.id);
      const request = text(row.requestId) ?? text(row.request_id);
      const session = text(row.sessionId) ?? text(row.session_id) ??
        (isRecord(row.metadata) ? text(row.metadata.sessionId) : null) ??
        (isRecord(message.metadata) ? text(message.metadata.sessionId) : null);
      if (!id || (!request && !session)) anonymous += tokens;
      else {
        const key = JSON.stringify([id, request ? "request" : "session", request ?? session]);
        if (!incomplete || !rows.has(key) || rows.get(key)?.incomplete) rows.set(key, { tokens, incomplete });
        if (rows.size > 100000) return null;
      }
    }
  }
  const total = anonymous + [...rows.values()].reduce((sum, value) => sum + value.tokens, 0);
  return total > 0 && Number.isFinite(total) ? total : null;
}

export const vertexai: Provider = {
  id: "vertexai",
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const config = context.env.CLOUDSDK_CONFIG || join(context.home, ".config", "gcloud");
    const path = context.env.GOOGLE_APPLICATION_CREDENTIALS || join(config, "application_default_credentials.json");
    const file = await context.readFile(path);
    let credentials: unknown;
    try { credentials = file ? JSON.parse(file) : null; } catch { throw new HttpError(NAME, 200); }
    if (!isRecord(credentials)) throw new NotConfigured(NAME);
    const service = text(credentials.client_email) && text(credentials.private_key);
    if (!service && !(text(credentials.refresh_token) && text(credentials.client_id) && text(credentials.client_secret))) throw new NotConfigured(NAME);
    const projectFile = await context.readFile(join(config, "configurations", "config_default"));
    const project = (service ? text(credentials.project_id) : null) ?? text(projectFile?.match(/^\s*project\s*=\s*(.+)$/m)?.[1]) ??
      text(context.env.GOOGLE_CLOUD_PROJECT) ?? text(context.env.GCLOUD_PROJECT) ?? text(context.env.CLOUDSDK_CORE_PROJECT);
    if (!project) throw new NotConfigured(NAME);
    let email = service ? text(credentials.client_email) : text(jwtPayload(text(credentials.id_token) ?? "")?.email);
    const base = () => ({ provider: "vertexai", provider_name: NAME, account: accountLabel(email), blocked: false,
      observed_at: new Date(context.now() * 1000).toISOString(), windows: [] });
    try {
      let token = text(credentials.access_token);
      if (service) {
        const result = await context.run("gcloud", ["auth", "application-default", "print-access-token"], { timeoutMs: 20000 });
        if (!result) throw new NotConfigured(NAME);
        if (result.code !== 0) throw new SignIn();
        token = text(result.stdout);
        if (!token) throw new HttpError(NAME, 200);
      } else {
        const expiry = isoToSeconds(credentials.token_expiry);
        if (!token || expiry === null || expiry < context.now() + 300) {
          // Google's ADC refresh tokens do not rotate; keep refreshed access tokens in memory only.
          const refreshed = await responseJson(context, "https://oauth2.googleapis.com/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ client_id: String(credentials.client_id), client_secret: String(credentials.client_secret),
              refresh_token: String(credentials.refresh_token), grant_type: "refresh_token" }).toString(),
          });
          token = text(refreshed.access_token);
          if (!token) throw new HttpError(NAME, 200);
          email = text(jwtPayload(text(refreshed.id_token) ?? "")?.email) ?? email;
        }
      }
      if (!token) throw new NotConfigured(NAME);
      const used = quotaPercent(await timeSeries(context, project, token, "allocation/usage"),
        await timeSeries(context, project, token, "limit"));
      const windows = used === null ? [] : [feedWindow(null, used, null, context.now(), "quota")];
      const tokens = await localTokens(context);
      if (tokens !== null) {
        const compact = Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens);
        windows.push(valueWindow("30d tok", compact.length <= 12 ? compact : tokens.toExponential(1)));
      }
      return [{ ...base(), windows, blocked: windows.some((window) => (window.used_percent ?? 0) >= 100) }];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base(), error: "sign in" }];
      throw error;
    }
  },
};
