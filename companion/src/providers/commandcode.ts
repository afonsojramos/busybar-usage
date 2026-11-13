import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { resolveKey, providerEntry } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  type Provider,
} from "./types.ts";

const ID = "commandcode";
const NAME = "Command Code";
const fail = (): never => {
  throw new HttpError(NAME, 200);
};
function number(value: unknown, strings = true, negative = false): number {
  const parsed = strings
    ? finiteNumber(value)
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : null;
  if (parsed === null || (!negative && parsed < 0)) return fail();
  return parsed;
}
function compact(value: number): string {
  const text = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
  return text.length <= 8 ? text : value.toExponential(0);
}
function money(value: number, currency = "USD"): string {
  const prefix =
    currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency + " ";
  const text = prefix + value.toFixed(2);
  return text.length <= 12 ? text : prefix + compact(value);
}
function date(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric !== null && numeric > 0
    ? numeric > 1e10
      ? numeric / 1000
      : numeric
    : isoToSeconds(value);
}
export const commandcode: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: ID,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const resolved = await resolveKey(context, ID, ["COMMAND_CODE_API_KEY"]);
    const key = resolved?.key ?? null;
    const headers: Record<string, string> = { Accept: "application/json" };
    const entry = await providerEntry(context, ID);
    const accounts = isRecord(entry.tokenAccounts) ? entry.tokenAccounts : null;
    const selected =
      accounts && Array.isArray(accounts.accounts)
        ? accounts.accounts[
            typeof accounts.activeIndex === "number" ? accounts.activeIndex : 0
          ]
        : null;
    const savedSession =
      entry.cookieSource === "manual" &&
      isRecord(selected) &&
      typeof selected.token === "string"
        ? selected.token.trim()
        : null;
    let prefix = "/alpha";
    if (
      key &&
      !savedSession &&
      !(resolved?.source === "codexbar" && !resolved.entry?.apiKey && accounts)
    )
      headers.Authorization = `Bearer ${key}`;
    else {
      let cookie =
        savedSession ??
        (await cookieHeader(context, ID, {
          domains: ["commandcode.ai", "www.commandcode.ai"],
        }));
      if (!cookie) throw new NotConfigured(NAME);
      cookie = cookie.replace(/^Cookie:\s*/i, "").trim();
      if (!cookie) throw new NotConfigured(NAME);
      if (!cookie.includes("=") && !cookie.includes(";"))
        cookie = `__Secure-commandcode_prod_.session_token=${cookie}`;
      headers.Cookie = cookie;
      headers.Accept = "application/json, text/plain, */*";
      headers["Accept-Language"] = "en-US,en;q=0.9";
      headers["User-Agent"] =
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
      headers.Origin = "https://commandcode.ai";
      headers.Referer = "https://commandcode.ai/";
      prefix = "/internal";
    }
    const get = async (
      url: string,
      additions: Record<string, string> = {},
    ): Promise<unknown> => {
      const response = await context.fetch(url, {
        headers: { ...headers, ...additions },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403)
        throw new SignIn();
      if (response.status === 429)
        throw new RateLimited(
          NAME,
          now + retryAfterSeconds(response.headers, 300),
        );
      if (!response.ok) throw new HttpError(NAME, response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError(NAME, response.status);
      }
    };
    try {
      const body = await get(
        `https://api.commandcode.ai${prefix}/billing/credits`,
      );
      if (!isRecord(body)) return fail();
      const windows: FeedWindow[] = [];
      if (!isRecord(body.credits)) return fail();
      const credits = body.credits;
      const monthly = number(credits.monthlyCredits, true, true);
      const purchased = finiteNumber(credits.purchasedCredits) ?? 0;
      const limits = isRecord(body.windowLimits)
        ? body.windowLimits
        : isRecord(credits.windowLimits)
          ? credits.windowLimits
          : {};
      for (const [key, minutes] of [
        ["fiveHour", 300],
        ["weekly", 10080],
      ] satisfies [string, number][]) {
        const w = limits[key];
        if (!isRecord(w)) continue;
        const cap = finiteNumber(w.cap);
        if (cap === null || cap <= 0) continue;
        windows.push(
          feedWindow(
            minutes,
            Math.min(100, ((finiteNumber(w.used) ?? 0) / cap) * 100),
            date(w.resetAt),
            now,
          ),
        );
      }
      let subscription: Record<string, unknown> | null = null;
      // Subscription enrichment is optional and must not discard fresh credits on failure.
      try {
        const response = await get(
          `https://api.commandcode.ai${prefix}/billing/subscriptions`,
        );
        if (
          isRecord(response) &&
          response.success === true &&
          isRecord(response.data)
        )
          subscription = response.data;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
      }
      const plans: Record<string, number> = {
        "individual-go": 10,
        "individual-go-v1": 10,
        "individual-goat": 70,
        "individual-pro": 30,
        "individual-pro-v1": 80,
        "individual-max": 150,
        "individual-ultra": 300,
      };
      const planId =
        typeof subscription?.planId === "string"
          ? subscription.planId.toLowerCase()
          : "";
      const reportedGrant = finiteNumber(credits.monthlyCreditsGranted);
      const grant =
        reportedGrant !== null && reportedGrant > 0
          ? reportedGrant
          : plans[planId];
      base.blocked = monthly <= 0;
      if (windows.length < 2)
        windows.push(
          grant !== undefined && grant > 0
            ? feedWindow(
                43200,
                Math.min(100, (Math.max(0, grant - monthly) / grant) * 100),
                date(subscription?.currentPeriodEnd),
                now,
                "30d",
              )
            : valueWindow("Monthly", money(monthly)),
        );
      if (windows.length < 2)
        windows.push(valueWindow("Bought", money(purchased)));
      return [
        {
          ...base,
          blocked:
            base.blocked || windows.some((w) => (w.used_percent ?? 0) >= 100),
          windows,
        },
      ];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};

class SignIn extends Error {}
