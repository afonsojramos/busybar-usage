import { join } from "node:path";
import { browserLocalStorage } from "../browser-local-storage.ts";
import { cookieHeader } from "../cookies.ts";
import { apiKey, providerEntry } from "../keys.ts";
import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  isProviderHost,
  retryAfterSeconds,
  type Context,
  type Provider,
} from "./types.ts";

const NAME = "Factory";
const HOSTS = ["auth.factory.ai", "api.factory.ai", "app.factory.ai"];
interface Auth {
  cookie: string | null;
  bearer: string | null;
  bases?: string[];
}

function date(value: unknown): number | null {
  const n = finiteNumber(value);
  return n === null ? isoToSeconds(value) : n > 1e12 ? n / 1000 : n;
}

export function parseBilling(json: unknown, now: number): FeedWindow[] | null {
  if (
    !isRecord(json) ||
    json.usesTokenRateLimitsBilling !== true ||
    !isRecord(json.limits) ||
    !isRecord(json.limits.standard)
  )
    return null;
  const windows: FeedWindow[] = [];
  for (const [key, minutes] of [
    ["fiveHour", 300],
    ["weekly", 10080],
  ] as const) {
    const window = json.limits.standard[key];
    if (!isRecord(window)) return null;
    const used = finiteNumber(window.usedPercent);
    if (used === null) return null;
    const seconds = finiteNumber(window.secondsRemaining);
    const end = date(window.windowEnd);
    const reset = seconds !== null && seconds > 0 ? now + seconds : end;
    windows.push(feedWindow(minutes, Math.min(100, Math.max(0, used)), reset, now));
  }
  return windows;
}

export function parseLegacy(json: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(json) || !isRecord(json.usage)) return null;
  const usage = json.usage;
  const windows: FeedWindow[] = [];
  for (const key of ["standard", "premium"]) {
    const lane = usage[key];
    if (!isRecord(lane)) continue;
    const used = finiteNumber(lane.userTokens) ?? 0;
    const allowance = finiteNumber(lane.totalAllowance) ?? 0;
    const ratio = finiteNumber(lane.usedRatio);
    let percent: number;
    const reliable = allowance > 0 && allowance <= 1e12;
    if (ratio !== null && !(ratio === 0 && used > 0 && reliable) && ratio >= -0.001 && ratio <= 1.001)
      percent = ratio * 100;
    else if (ratio !== null && !reliable && ratio >= -0.1 && ratio <= 100.1) percent = ratio;
    else if (allowance > 1e12) percent = (used / 100_000_000) * 100;
    else percent = allowance > 0 ? (used / allowance) * 100 : 0;
    windows.push(
      feedWindow(
        null,
        Math.min(100, Math.max(0, percent)),
        date(usage.endDate),
        now,
        key === "standard" ? "std" : "prem",
      ),
    );
  }
  return windows.length ? windows : null;
}

function manual(raw: string): Auth {
  const bearer = /(?:authorization\s*:\s*)?bearer\s+([A-Za-z0-9._~+/=-]+)/i.exec(raw)?.[1];
  if (bearer) return { bearer, cookie: null };
  const cookie = raw.replace(/^Cookie:\s*/i, "").trim();
  if (cookie.includes("=")) {
    const token = /(?:^|;)\s*access-token\s*=\s*([^;]+)/.exec(cookie)?.[1] ?? null;
    return { bearer: token, cookie };
  }
  return { bearer: cookie.length >= 40 || cookie.split(".").length >= 3 ? cookie : null, cookie: null };
}

async function request(context: Context, url: string, auth: Auth): Promise<{ json: unknown; status: number }> {
  const response = await context.fetch(url, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://app.factory.ai",
      Referer: "https://app.factory.ai/",
      "x-factory-client": "web-app",
      ...(auth.bearer ? { Authorization: `Bearer ${auth.bearer}` } : {}),
      ...(auth.cookie ? { Cookie: auth.cookie } : {}),
    },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new HttpError(NAME, response.status);
  }
  return { json, status: response.status };
}

async function fetchAuth(context: Context, auth: Auth, base: string): Promise<FeedAccount> {
  const now = context.now();
  const identity = await request(context, `${base}/api/app/auth/me`, auth);
  if (!isRecord(identity.json)) throw new HttpError(NAME, identity.status);
  const profile = isRecord(identity.json.userProfile) ? identity.json.userProfile : {};
  const email = typeof profile.email === "string" ? profile.email : null;
  let userId = typeof profile.id === "string" ? profile.id : null;
  if (!userId && auth.bearer) {
    const part = auth.bearer.split(".")[1];
    if (part)
      try {
        const jwt: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
        if (isRecord(jwt) && typeof jwt.sub === "string") userId = jwt.sub;
      } catch {
        /* Identity metadata is optional. */
      }
  }
  let windows: FeedWindow[] | null = null;
  try {
    const billing = await request(context, "https://api.factory.ai/api/billing/limits", auth);
    windows = parseBilling(billing.json, now);
  } catch (error) {
    if (error instanceof RateLimited) throw error;
    if (error instanceof HttpError && error.status !== 404 && error.status !== 405) throw error;
    if (!(error instanceof HttpError)) throw error;
  }
  if (!windows) {
    const query = new URLSearchParams({ useCache: "true" });
    if (userId) query.set("userId", userId);
    const legacy = await request(context, `${base}/api/organization/subscription/usage?${query}`, auth);
    windows = parseLegacy(legacy.json, now);
    if (!windows) throw new HttpError(NAME, legacy.status);
  }
  return {
    provider: "factory",
    account: accountLabel(email),
    observed_at: new Date(now * 1000).toISOString(),
    windows,
    blocked: windows.some((w) => (w.used_percent ?? 0) >= 100),
  };
}

async function storedAuths(context: Context): Promise<Auth[]> {
  const result: Auth[] = [];
  if (context.platform === "darwin") {
    const cached = await context.readKeychain("com.steipete.codexbar.cache", "cookie.factory");
    if (cached) {
      try {
        const json: unknown = JSON.parse(cached);
        if (isRecord(json) && typeof json.cookieHeader === "string") result.push(manual(json.cookieHeader));
      } catch {
        result.push(manual(cached));
      }
    }
  }
  const text = await context.readFile(join(context.home, "Library/Application Support/CodexBar/factory-session.json"));
  if (!text) return result;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return result;
  }
  const cookies = isRecord(json) ? json.cookies : Array.isArray(json) ? json : null;
  if (Array.isArray(cookies)) {
    const parts: string[] = [];
    for (const cookie of cookies) {
      if (
        !isRecord(cookie) ||
        typeof cookie.Name !== "string" ||
        typeof cookie.Value !== "string" ||
        typeof cookie.Domain !== "string"
      )
        continue;
      if (!HOSTS.includes(cookie.Domain.replace(/^\./, "")) && cookie.Domain.replace(/^\./, "") !== "factory.ai")
        continue;
      const expiry = date(cookie.Expires);
      if (expiry !== null && expiry <= context.now()) continue;
      if (/^[^\s;=]+$/.test(cookie.Name) && !/[\r\n;]/.test(cookie.Value)) parts.push(`${cookie.Name}=${cookie.Value}`);
    }
    if (parts.length)
      result.push({
        ...manual(parts.join("; ")),
        bases: [
          ...(cookies.some(
            (c) => isRecord(c) && typeof c.Domain === "string" && c.Domain.replace(/^\./, "") === "auth.factory.ai",
          )
            ? ["https://auth.factory.ai"]
            : []),
          "https://api.factory.ai",
          "https://app.factory.ai",
        ],
      });
  }
  if (isRecord(json) && typeof json.bearerToken === "string" && json.bearerToken.trim())
    result.push({ bearer: json.bearerToken.trim(), cookie: null });
  // WorkOS refresh tokens rotate, so the session owner must refresh them.
  return result;
}

async function safariAuths(context: Context): Promise<Auth[]> {
  if (context.platform !== "darwin") return [];
  const root = join(context.home, "Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default");
  const pending = [{ path: root, depth: 0 }];
  const result: Auth[] = [];
  for (let i = 0; i < pending.length && i < 10000; i++) {
    const item = pending[i];
    if (!item || item.depth > 12) continue;
    let entries: string[] | null;
    try {
      entries = await context.listDir(item.path);
    } catch {
      continue;
    }
    if (!entries) continue;
    if (entries.includes("origin")) {
      try {
        const origin = await context.readFileBytes(join(item.path, "origin"));
        const text = origin ? Buffer.from(origin).toString("latin1") : "";
        if (!text.includes("app.factory.ai") && !text.includes("auth.factory.ai")) continue;
        const db = join(item.path, "LocalStorage/localstorage.sqlite3");
        const tables = await context.querySqlite(db, "SELECT name FROM sqlite_master WHERE type='table'");
        const table = tables?.some((row) => row.name === "ItemTable")
          ? "ItemTable"
          : tables?.some((row) => row.name === "localstorage")
            ? "localstorage"
            : null;
        if (!table) continue;
        const rows = await context.querySqlite(db, `SELECT value FROM ${table} WHERE key = ? LIMIT 1`, [
          "workos:access-token",
        ]);
        const raw = rows?.[0]?.value;
        let token: string | null = typeof raw === "string" ? raw : null;
        if (raw instanceof Uint8Array) {
          const bytes = Buffer.from(raw);
          token = bytes.some((b, index) => index % 2 === 1 && b === 0)
            ? bytes.toString("utf16le")
            : bytes.toString("utf8");
        }
        if (token?.trim()) result.push({ bearer: token.trim(), cookie: null });
      } catch {
        continue;
      }
    }
    for (const name of entries) {
      if (!name.startsWith(".") && name !== "origin" && !name.includes("/") && name !== "LocalStorage")
        pending.push({ path: join(item.path, name), depth: item.depth + 1 });
    }
  }
  return result;
}

export const factory: Provider = {
  id: "factory",
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, "factory");
    let baseURL = "https://app.factory.ai";
    if (typeof entry.baseURL === "string" && entry.baseURL) {
      let url: URL;
      try {
        url = new URL(entry.baseURL);
      } catch {
        throw new NotConfigured(NAME);
      }
      if (!isProviderHost(url, HOSTS) || url.username || url.password) throw new NotConfigured(NAME);
      baseURL = url.origin;
    }
    let key = await apiKey(context, "factory", ["FACTORY_API_KEY"]);
    if (!key) {
      const dotenv = await context.readFile(join(context.home, ".factory/.env"));
      const value = dotenv
        ?.split(/\r?\n/)
        .map((line) => /^(?:export\s+)?FACTORY_API_KEY\s*=\s*(.*?)\s*$/.exec(line.trim())?.[1])
        .find((v) => v?.trim());
      if (value)
        key = await apiKey(
          { ...context, env: { ...context.env, FACTORY_API_KEY: value.replace(/^(['"])(.*)\1$/, "$2") } },
          "factory",
          ["FACTORY_API_KEY"],
        );
    }
    let lastError: unknown;
    let rejected = false;
    let attempted = false;
    async function attempt(auth: Auth, bases: string[]): Promise<FeedAccount | null> {
      if (!auth.cookie && !auth.bearer) return null;
      attempted = true;
      for (const base of new Set(auth.bases ?? bases)) {
        try {
          return await fetchAuth(context, auth, base);
        } catch (error) {
          if (error instanceof RateLimited || (error instanceof Error && error.name === "AbortError")) throw error;
          lastError = error;
          if (error instanceof HttpError && (error.status === 401 || error.status === 403)) rejected = true;
          if (auth.cookie && error instanceof HttpError && [401, 403, 409].includes(error.status)) {
            const alternatives: Auth[] = [];
            if (auth.bearer) alternatives.push({ cookie: auth.cookie, bearer: null });
            if (error.status === 409) {
              const sessionNames = new Set([
                "wos-session",
                "__Secure-next-auth.session-token",
                "next-auth.session-token",
                "__Secure-authjs.session-token",
                "authjs.session-token",
                "session",
              ]);
              for (const remove of [
                new Set(["access-token", "__recent_auth"]),
                sessionNames,
                new Set(["access-token", "__recent_auth", ...sessionNames]),
              ]) {
                const filtered = auth.cookie
                  .split(";")
                  .map((p) => p.trim())
                  .filter((p) => !remove.has(p.split("=")[0] ?? ""))
                  .join("; ");
                if (filtered && filtered !== auth.cookie) alternatives.push(manual(filtered));
              }
            }
            for (const alternative of alternatives) {
              try {
                return await fetchAuth(context, alternative, base);
              } catch (retryError) {
                if (
                  retryError instanceof RateLimited ||
                  (retryError instanceof Error && retryError.name === "AbortError")
                )
                  throw retryError;
                if (!(retryError instanceof HttpError) || ![401, 403, 409].includes(retryError.status))
                  throw retryError;
                lastError = retryError;
                if (retryError.status === 401 || retryError.status === 403) rejected = true;
              }
            }
          }
        }
      }
      return null;
    }
    if (key && entry.source !== "web") {
      const result = await attempt({ bearer: key, cookie: null }, ["https://api.factory.ai", baseURL]);
      if (result) return [result];
    }
    if (entry.source !== "api" && entry.cookieSource !== "off") {
      if (entry.cookieSource !== "manual") {
        for (const auth of await storedAuths(context)) {
          const result = await attempt(auth, ["https://api.factory.ai", baseURL]);
          if (result) return [result];
        }
      }
      if (entry.cookieSource !== "manual") {
        for (const auth of await safariAuths(context)) {
          const result = await attempt(auth, ["https://api.factory.ai", baseURL]);
          if (result) return [result];
        }
      }
      if (entry.cookieSource !== "manual") {
        for (const origin of ["https://app.factory.ai", "https://auth.factory.ai", "https://factory.ai"]) {
          const token = await browserLocalStorage(context, origin, "workos:access-token");
          if (!token?.trim()) continue;
          const result = await attempt({ bearer: token.trim(), cookie: null }, ["https://api.factory.ai", baseURL]);
          if (result) return [result];
        }
      }
      const cookie =
        entry.cookieSource === "manual" && (typeof entry.cookieHeader !== "string" || !entry.cookieHeader.trim())
          ? null
          : await cookieHeader(context, "factory", { domains: ["factory.ai", "app.factory.ai", "auth.factory.ai"] });
      if (cookie) {
        const selected = manual(cookie);
        const result = await attempt(
          selected,
          selected.cookie
            ? [baseURL, "https://auth.factory.ai", "https://api.factory.ai"]
            : ["https://api.factory.ai", baseURL],
        );
        if (result) return [result];
      }
    }
    if (rejected)
      return [
        {
          provider: "factory",
          account: accountLabel(null),
          observed_at: new Date(context.now() * 1000).toISOString(),
          windows: [],
          blocked: false,
          error: "sign in",
        },
      ];
    if (lastError) throw lastError;
    if (!attempted) throw new NotConfigured(NAME);
    throw new HttpError(NAME, 200);
  },
};
