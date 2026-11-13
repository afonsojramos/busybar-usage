import { accountLabel, feedWindow, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  isProviderHost,
  type Context,
  type Provider,
} from "./types.ts";

const ID = "zoommate";
const NAME = "ZoomMate";
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
      accept: "application/json",
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

export const zoommate: Provider = {
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
    const saved = await cookieHeader(context, ID, { domains: ["zoom.us", "ai.zoom.us", "zoommate.zoom.us"] });
    if (!saved) throw new NotConfigured(NAME);
    const capture = saved.trim().startsWith("curl ") ? parseCapture(saved) : null;
    if (entry.cookieSource === "manual" && !capture) throw new NotConfigured(NAME);
    const hosts =
      capture?.host === "zoommate.zoom.us" ? ["zoommate.zoom.us", "ai.zoom.us"] : ["ai.zoom.us", "zoommate.zoom.us"];
    const headers: Record<string, string> = {
      accept: "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      ...capture?.headers,
      Origin: "https://zoommate.zoom.us",
      Referer: "https://zoommate.zoom.us",
    };
    const fetchData = async (path: string, token?: string): Promise<Record<string, unknown>> => {
      let failure: unknown;
      for (const host of hosts) {
        try {
          const scoped = { ...headers };
          // The broker returns one header, so never forward its cookies to the sibling host.
          if (host === hosts[0]) {
            const cookie = capture ? capture.cookie : saved;
            if (cookie) scoped.Cookie = cookie;
          }
          if (token) scoped.Authorization = /^bearer /i.test(token) ? token : `Bearer ${token}`;
          const result = await request(context, `https://${host}/ai-computer/api/v1/${path}`, scoped);
          return object(object(result).data);
        } catch (error) {
          if (error instanceof RateLimited || (error instanceof HttpError && [200, 401, 403].includes(error.status)))
            throw error;
          if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
          failure = error;
        }
      }
      throw failure;
    };
    try {
      let token = capture?.authorization;
      if (!token) {
        const login = await fetchData("login/?continue=https%3A%2F%2Fzoommate.zoom.us%2F");
        token = text(login.nak) ?? undefined;
        if (!token) return invalid();
        base.account = accountLabel(isRecord(login.user_profile) ? text(login.user_profile.email) : null);
      }
      const status = object((await fetchData("credits/status", token)).credit_status);
      for (const field of [
        "budget_cap",
        "used_credit",
        "remaining_credit",
        "overage_credit",
        "cycle_start_date",
        "cycle_end_date",
      ])
        if (status[field] != null) numeric(status[field]);
      for (const field of ["cycle_start_date", "cycle_end_date"])
        if (status[field] != null && !Number.isSafeInteger(status[field])) return invalid();
      for (const field of ["allow_overage", "is_quota_available", "is_unlimited"])
        if (status[field] != null && typeof status[field] !== "boolean") return invalid();
      const cap = status.budget_cap == null ? 0 : numeric(status.budget_cap);
      const used = status.used_credit == null ? 0 : numeric(status.used_credit);
      const unlimited = status.is_unlimited === true || cap <= 0;
      const end = status.cycle_end_date == null ? null : numeric(status.cycle_end_date) / 1000;
      const start = status.cycle_start_date == null ? null : numeric(status.cycle_start_date) / 1000;
      const minutes = start !== null && end !== null && end > start ? Math.trunc((end - start) / 60) : null;
      const windows = [
        unlimited
          ? valueWindow("Credits", "unlimited")
          : feedWindow(
              minutes,
              Math.min(100, Math.max(0, (used / cap) * 100)),
              end !== null && end > 0 ? end : null,
              context.now(),
              minutes === 43200 ? "30d" : "Credits",
            ),
      ];
      return [
        {
          ...base,
          blocked: status.is_quota_available === false || windows.some((w) => (w.used_percent ?? 0) >= 100),
          windows,
        },
      ];
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};

function parseCapture(raw: string): {
  host: string;
  authorization: string;
  cookie: string | null;
  headers: Record<string, string>;
} {
  // Tokenize cURL arguments without ever executing the pasted command.
  const args: string[] = [];
  let word = "",
    quote = "",
    active = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === "\\" && quote !== "'") {
      if (i + 1 >= raw.length) throw new NotConfigured(NAME);
      const next = raw[++i];
      if (next !== "\n") {
        word += next;
        active = true;
      }
    } else if (quote) {
      if (char === quote) quote = "";
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/.test(char)) {
      if (active) args.push(word);
      word = "";
      active = false;
    } else {
      word += char;
      active = true;
    }
  }
  if (quote) throw new NotConfigured(NAME);
  if (active) args.push(word);
  if (args[0] !== "curl") throw new NotConfigured(NAME);
  const urls = args.filter((arg) => arg.startsWith("https://"));
  if (urls.length !== 1) throw new NotConfigured(NAME);
  let url: URL;
  try {
    url = new URL(urls[0]);
  } catch {
    throw new NotConfigured(NAME);
  }
  if (
    !isProviderHost(url, ["ai.zoom.us", "zoommate.zoom.us"]) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/ai-computer/api/v1/credits/status"
  )
    throw new NotConfigured(NAME);
  const headers: Record<string, string> = {};
  const allowed = [
    "authorization",
    "cookie",
    "user-agent",
    "accept",
    "accept-language",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
  ];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const field = arg === "-H" || arg === "--header" ? args[++i] : arg.startsWith("--header=") ? arg.slice(9) : null;
    if (field) {
      const colon = field.indexOf(":");
      if (colon <= 0 || /[\r\n\x00]/.test(field)) throw new NotConfigured(NAME);
      const name = field.slice(0, colon).trim().toLowerCase();
      if (allowed.includes(name)) headers[name] = field.slice(colon + 1).trim();
    }
    if (arg === "-b" || arg === "--cookie") {
      const value = args[++i];
      if (!value || !value.includes("=") || /[\r\n\x00]/.test(value)) throw new NotConfigured(NAME);
      headers.cookie = value;
    }
  }
  const authorization = headers.authorization;
  if (!authorization) throw new NotConfigured(NAME);
  const cookie = headers.cookie ?? null;
  delete headers.authorization;
  delete headers.cookie;
  return { host: url.hostname, authorization, cookie, headers };
}
