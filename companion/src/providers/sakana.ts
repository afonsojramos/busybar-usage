import { accountLabel, feedWindow, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

function resetDate(text: string | undefined): number | null {
  const match = /^(\w+) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) (AM|PM)$/i.exec(text ?? "");
  if (!match) return null;
  const month = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ].indexOf(match[1].toLowerCase());
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 0 || hour < 1 || hour > 12 || minute > 59) return null;
  const date = new Date(
    Date.UTC(
      Number(match[3]),
      month,
      Number(match[2]),
      (hour % 12) + (match[6].toUpperCase() === "PM" ? 12 : 0),
      minute,
    ),
  );
  return date.getUTCMonth() === month && date.getUTCDate() === Number(match[2]) ? date.getTime() / 1000 : null;
}

function parseUsage(html: string, now: number): FeedWindow[] {
  const windows: FeedWindow[] = [];
  for (const [label, minutes] of [
    ["5-hour", 300],
    ["Weekly", 10080],
  ] satisfies [string, number][]) {
    const match = new RegExp(`<p[^>]*>\\s*${label}\\s*</p>`, "i").exec(html);
    if (!match) continue;
    const rest = html.slice(match.index + match[0].length);
    const boundary =
      /<p[^>]*>\s*(?:5-hour|Weekly)\s*<\/p>|<div[^>]*data-slot=(?:"card"|'card'|"card-title"|'card-title')[^>]*>/i.exec(
        rest,
      );
    const body = rest.slice(0, boundary ? boundary.index : rest.length).trim();
    if (!body) continue;
    const percent = /<p[^>]*>\s*([0-9]+(?:\.[0-9]+)?)% used\s*<\/p>/i.exec(body)?.[1];
    const used = Number(percent);
    if (percent === undefined || !Number.isFinite(used) || used > 100) throw new HttpError("Sakana", 200);
    const reset = /<p[^>]*>\s*Resets on ([^<]+?)\s*<\/p>/i.exec(body)?.[1];
    windows.push(feedWindow(minutes, used, resetDate(reset), now));
  }
  if (!windows.length) throw new HttpError("Sakana", 200);
  return windows;
}

export const sakana: Provider = {
  id: "sakana",
  name: "Sakana",
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, "sakana");
    // Sakana supports manual cookies only; do not turn anonymous browser cookies into credentials.
    if (
      !context.env.SAKANA_COOKIE?.trim() &&
      !(isRecord(entry) && typeof entry.cookieHeader === "string" && entry.cookieHeader.trim())
    )
      throw new NotConfigured("Sakana");
    const cookie = await cookieHeader(context, "sakana", { domains: [], envNames: ["SAKANA_COOKIE"] });
    if (!cookie) throw new NotConfigured("Sakana");
    const now = context.now();
    const base: FeedAccount = {
      provider: "sakana",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const headers = {
      Cookie: cookie.replace(/^cookie:\s*/i, ""),
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    };
    const response = await context.fetch("https://console.sakana.ai/billing", {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400))
      return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Sakana", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Sakana", response.status);
    const windows = parseUsage(await response.text(), now);
    if (windows.length < 2) {
      try {
        const payg = await context.fetch("https://console.sakana.ai/billing?tab=payAsYouGo", {
          headers,
          signal: AbortSignal.timeout(30_000),
          redirect: "manual",
        });
        if (payg.ok) {
          const text = await payg.text();
          const match =
            /<h2[^>]*>\s*Credit balance\s*<\/h2>[\s\S]{0,900}?<p[^>]*tabular-nums[^"]*"[^>]*>\$?([0-9][0-9,]*(?:\.[0-9]+)?)<\/p>/i.exec(
              text,
            );
          const balance = match ? Number(match[1].replace(/,/g, "")) : NaN;
          if (Number.isFinite(balance)) {
            const amount = `$${balance.toFixed(2)}`;
            windows.push(valueWindow("Balance", amount.length <= 12 ? amount : `$${balance.toExponential(2)}`));
          }
        }
      } catch {
        /* PAYG is optional and cannot hide subscription quotas. */
      }
    }
    return [{ ...base, windows, blocked: windows.some((window) => (window.used_percent ?? 0) >= 100) }];
  },
};
