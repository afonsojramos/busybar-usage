import { accountLabel, feedWindow, isRecord, type FeedWindow } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const ALLOWED = new Set([
  "accept",
  "accept-language",
  "cache-control",
  "pragma",
  "priority",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "trpc-accept",
  "user-agent",
  "x-client-context",
  "x-deployment-id",
  "x-trpc-batch",
  "x-trpc-source",
]);

function unescapeSegment(raw: string, ansi: boolean): string {
  return raw.replace(/\\([\s\S])/g, (_, next: string) => {
    if (next === "\n") return "";
    if (ansi && next === "n") return "\n";
    if (ansi && next === "r") return "\r";
    if (ansi && next === "t") return "\t";
    return next;
  });
}

function capturedHeaders(raw: string): { cookie: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  let cookie = raw.trim().replace(/^cookie:\s*/i, "");
  if (/^curl\s/.test(raw)) {
    cookie = "";
    // Parse quoted header arguments as data; never execute the captured command.
    const pattern =
      /(?:^|\s)(?:-H|--header)(?:\s+|=|(?=['"$]))(?:\$'((?:\\.|[^'])*)'|'([^']*)'|"((?:\\.|[^"])*)"|(\S+))/gs;
    for (const match of raw.matchAll(pattern)) {
      const field =
        match[1] !== undefined
          ? unescapeSegment(match[1], true)
          : (match[2] ?? unescapeSegment(match[3] ?? match[4], false));
      const colon = field.indexOf(":");
      if (colon < 0) continue;
      const name = field.slice(0, colon).trim().toLowerCase();
      const value = field.slice(colon + 1).trim();
      if (name === "cookie" && !cookie) cookie = value;
      else if (ALLOWED.has(name)) headers[name] = value;
    }
  }
  return { cookie, headers };
}

function customerData(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 40 || typeof value !== "object" || value === null) return null;
  if (
    isRecord(value) &&
    ("usageFourHourPercentage" in value ||
      "usageMonthPercentage" in value ||
      ("subscription" in value && "usageBand" in value))
  )
    return value;
  for (const child of Object.values(value)) {
    const result = customerData(child, depth + 1);
    if (result) return result;
  }
  return null;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value > 1e10
      ? value / 1000
      : value
    : null;
}

function parseUsage(text: string, now: number): FeedWindow[] | null {
  let data: Record<string, unknown> | null = null;
  for (const line of text.split(/\r?\n/)) {
    try {
      data = customerData(JSON.parse(line));
    } catch {
      continue;
    }
    if (data) break;
  }
  if (!data) return null;
  for (const key of [
    "usageFourHourPercentage",
    "usageMonthPercentage",
    "usagePeriodPercentage",
    "usageFourHourNextResetAt",
    "usageWindowNextResetAt",
    "billingNextResetAt",
    "lifetimeBalance",
  ]) {
    if (data[key] != null && (typeof data[key] !== "number" || !Number.isFinite(data[key]))) return null;
  }
  for (const key of ["subTier", "usageBand"]) {
    if (data[key] != null && typeof data[key] !== "string") return null;
  }
  const subscription = data.subscription;
  if (subscription != null && !isRecord(subscription)) return null;
  if (isRecord(subscription)) {
    for (const key of ["productId", "productName", "status"]) {
      if (subscription[key] != null && typeof subscription[key] !== "string") return null;
    }
    for (const key of ["currentPeriodStart", "currentPeriodEnd", "canceledAt", "trialEndsAt"]) {
      if (subscription[key] != null && (typeof subscription[key] !== "number" || !Number.isFinite(subscription[key])))
        return null;
    }
  }
  const primary = typeof data.usageFourHourPercentage === "number" ? data.usageFourHourPercentage : 0;
  const secondary = data.usageMonthPercentage ?? data.usagePeriodPercentage ?? 0;
  if (typeof secondary !== "number") return null;
  return [
    feedWindow(
      240,
      Math.min(100, primary),
      timestamp(data.usageFourHourNextResetAt) ?? timestamp(data.usageWindowNextResetAt),
      now,
    ),
    feedWindow(
      43200,
      Math.min(100, secondary),
      isRecord(subscription) ? timestamp(subscription.currentPeriodEnd) : null,
      now,
    ),
  ];
}

export const t3chat: Provider = {
  id: "t3chat",
  name: "T3 Chat",
  async fetch(context) {
    const entry = await providerEntry(context, "t3chat");
    if (
      entry.cookieSource === "off" ||
      (entry.cookieSource === "manual" && (typeof entry.cookieHeader !== "string" || !entry.cookieHeader.trim()))
    )
      throw new NotConfigured("T3 Chat");
    const raw = await cookieHeader(context, "t3chat", { domains: ["t3.chat"] });
    const capture = capturedHeaders(raw ?? "");
    if (!capture.cookie) throw new NotConfigured("T3 Chat");
    const now = context.now();
    const base = {
      provider: "t3chat",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const input = encodeURIComponent(
      JSON.stringify({
        0: {
          json: { sessionId: null },
          meta: { values: { sessionId: ["undefined"] } },
        },
      }),
    );
    const response = await context.fetch(`https://t3.chat/api/trpc/getCustomerData?batch=1&input=${input}`, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        Priority: "u=4",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Referer: "https://t3.chat/settings/customization",
        "trpc-accept": "application/jsonl",
        "x-trpc-source": "web-client",
        "x-trpc-batch": "true",
        ...capture.headers,
        Cookie: capture.cookie,
        Origin: "https://t3.chat",
      },
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("T3 Chat", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("T3 Chat", response.status);
    const windows = parseUsage(await response.text(), now);
    if (windows === null) throw new HttpError("T3 Chat", response.status);
    return [{ ...base, windows, blocked: windows.some((window) => (window.used_percent ?? 0) >= 100) }];
  },
};
