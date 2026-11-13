import { accountLabel, finiteNumber, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  isProviderHost,
  type Context,
  type Provider, type RequestOptions } from "./types.ts";

const ID = "deepgram";

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

function endpoint(raw: string, hosts: string[]): URL {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new NotConfigured(ID);
  }
  if (!isProviderHost(url, hosts) || url.username || url.password) throw new NotConfigured(ID);
  return url;
}

export const deepgram: Provider = {
  id: ID,
  name: "Deepgram",
  async fetch(context) {
    const key = await apiKey(context, ID, ["DEEPGRAM_API_KEY"]);
    if (!key) throw new NotConfigured(ID);
    const entry = await providerEntry(context, ID);
    const baseURL = endpoint(context.env.DEEPGRAM_API_URL || "https://api.deepgram.com/v1", ["api.deepgram.com"]);
    if (baseURL.search || baseURL.hash) throw new NotConfigured(ID);
    const basePath = baseURL.pathname.replace(/\/+$/, "");
    const configured = context.env.DEEPGRAM_PROJECT_ID || entry.workspaceID;
    async function get(path: string): Promise<unknown> {
      const url = new URL(baseURL);
      url.pathname = `${basePath}/${path}`;
      return request(context, url, key!, { headers: { Authorization: `Token ${key}` } });
    }
    try {
      let projects: string[];
      if (typeof configured === "string" && configured.trim()) projects = [configured.trim()];
      else {
        const data = object(await get("projects"));
        if (!Array.isArray(data.projects)) throw new HttpError(ID, 200);
        projects = data.projects.map((raw) => {
          const project = object(raw);
          if (typeof project.project_id !== "string" || (project.name != null && typeof project.name !== "string"))
            throw new HttpError(ID, 200);
          return project.project_id;
        });
      }
      if (!projects.length) throw new HttpError(ID, 200);
      let hours = 0,
        requests = 0;
      for (const project of projects) {
        const data = object(await get(`projects/${encodeURIComponent(project)}/usage/breakdown`));
        if (!Array.isArray(data.results)) throw new HttpError(ID, 200);
        for (const field of ["start", "end"])
          if (data[field] != null && typeof data[field] !== "string") throw new HttpError(ID, 200);
        if (data.resolution != null) {
          const resolution = object(data.resolution);
          if (
            (resolution.units != null && typeof resolution.units !== "string") ||
            (resolution.amount != null && !Number.isInteger(resolution.amount))
          )
            throw new HttpError(ID, 200);
        }
        for (const raw of data.results) {
          const row = object(raw);
          for (const field of [
            "hours",
            "total_hours",
            "agent_hours",
            "tokens_in",
            "tokens_out",
            "tts_characters",
            "requests",
          ]) {
            const value = row[field];
            if (
              value != null &&
              (typeof value !== "number" ||
                !Number.isFinite(value) ||
                (["tokens_in", "tokens_out", "tts_characters", "requests"].includes(field) && !Number.isInteger(value)))
            )
              throw new HttpError(ID, 200);
          }
          hours += finiteNumber(row.hours) ?? 0;
          requests += finiteNumber(row.requests) ?? 0;
        }
      }
      if (!Number.isFinite(hours) || !Number.isFinite(requests)) throw new HttpError(ID, 200);
      const compact = (n: number) =>
        new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
      return finish(context, [
        valueWindow("audio", `${compact(hours)} h`.slice(0, 12)),
        valueWindow("reqs", compact(requests).slice(0, 12)),
      ]);
    } catch (error) {
      return signIn(context, error);
    }
  },
};
