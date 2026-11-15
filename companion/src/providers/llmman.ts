import { accountLabel, feedWindow, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "llmman";
const NAME = "llmman";

class SignIn extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(NAME, 200);
  return value;
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new HttpError(NAME, 200);
  return value.trim() || null;
}

function privateHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "[::1]" || /^\[f[cd][0-9a-f]{2}:/i.test(host) || /^\[fe[89ab][0-9a-f]:/i.test(host)) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return (
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
  );
}

function endpoint(raw: string | null, policy: "private" | "loopback" | "https" = "private"): URL {
  if (!raw) throw new NotConfigured(NAME);
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new NotConfigured(NAME);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname.startsWith("127.");
  const http =
    url.protocol === "http:" && (policy === "private" ? privateHost(url.hostname) : policy === "loopback" && loopback);
  if ((url.protocol !== "https:" && !http) || url.username || url.password) throw new NotConfigured(NAME);
  return url;
}

async function request(context: Context, url: URL, key: string | null): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const response = await context.fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (response.status === 401 || response.status === 403) throw new SignIn();
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try {
    return await response.json();
  } catch {
    throw new HttpError(NAME, response.status);
  }
}

export const llmman: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, ID, ["LLMMAN_API_KEY"]);

    const entry = await providerEntry(context, ID);
    const now = context.now();
    const base: FeedAccount = {
      provider: ID,
      provider_name: NAME,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    try {
      const configured = text(context.env.LLMMAN_HOST) ?? text(entry.enterpriseHost);
      const raw = configured ?? "http://127.0.0.1:17434";
      const hasScheme = raw.includes("://");
      let url: URL;
      try {
        url = new URL(hasScheme ? raw : "http://" + raw);
      } catch {
        throw new NotConfigured(NAME);
      }
      if (!hasScheme && !url.port) url.port = "17434";
      if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
      url = endpoint(url.href);
      if (url.search || url.hash) throw new NotConfigured(NAME);
      const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
      url.pathname = path + "/llmman/node";
      const root = object(
        await request(context, url, key).catch((error: unknown) => {
          // Nothing listening at the default address, with none configured, means llmman is not running here.
          if (!configured && error instanceof TypeError) throw new NotConfigured(NAME);
          throw error;
        }),
      );
      const bytes = (value: unknown): number => {
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new HttpError(NAME, 200);
        return value;
      };
      const total = (value: unknown) => {
        const sum = Object.values(object(value)).reduce<number>((sum, size) => sum + bytes(size), 0);
        return bytes(sum);
      };
      const memory = bytes(root.memory);
      const loaded = total(root.loaded);
      const stored = total(root.stored);
      // The version is optional and has no effect on the memory measurement.
      try {
        url.pathname = path + "/api/version";
        await request(context, url, key);
      } catch (error) {
        if (error instanceof RateLimited || error instanceof SignIn) throw error;
        if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
      }
      const size = (value: number) => {
        const [scale, unit] =
          value >= 1e9 ? [1e9, "GB"] : value >= 1e6 ? [1e6, "MB"] : value >= 1e3 ? [1e3, "kB"] : [1, "B"];
        return (value / scale).toFixed(scale === 1 ? 0 : 1) + " " + unit;
      };
      const windows =
        memory > 0
          ? [feedWindow(null, (loaded / memory) * 100, null, now, "memory")]
          : [valueWindow("loaded", size(loaded).slice(0, 12))];
      windows.push(valueWindow("stored", size(stored).slice(0, 12)));
      return [{ ...base, windows, blocked: memory > 0 && loaded >= memory }];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
