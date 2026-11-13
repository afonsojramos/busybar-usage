import { accountLabel, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const ID = "parallel";
const NAME = "Parallel";
const invalid = (): never => {
  throw new HttpError(NAME, 200);
};
const object = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : invalid());
const numeric = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : invalid());
const compact = (value: number): string =>
  Math.abs(value) >= 1e12
    ? value.toExponential(1)
    : new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 2,
      }).format(value);
const money = (value: number): string =>
  value > 0 && value < 0.01 ? "<$0.01" : Math.abs(value) < 1e8 ? `$${value.toFixed(2)}` : `$${compact(value)}`;

export const parallel: Provider = {
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
    const cookie = await cookieHeader(context, ID, { domains: ["platform.parallel.ai"] });
    if (!cookie) throw new NotConfigured(NAME);
    const response = await context.fetch("https://platform.parallel.ai/api/rpc/billing/payments/refresh-balance", {
      method: "POST",
      redirect: "manual",
      body: "{}",
      signal: AbortSignal.timeout(30_000),
      headers: { Cookie: cookie, Origin: "https://platform.parallel.ai", "Content-Type": "application/json" },
    });
    if (
      [401, 403].includes(response.status) ||
      (response.status >= 300 && response.status < 400) ||
      (response.ok && response.headers.get("content-type")?.includes("text/html"))
    )
      return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError(NAME, response.status);
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return invalid();
    }
    const payload = object(raw);
    if (payload.kind !== "ok") return invalid();
    const data = object(payload.data);
    const balance = numeric(data.balance);
    const windows = [valueWindow("Balance", money(balance / 100))];
    if (
      typeof data.pendingDebitBalanceCents === "number" &&
      Number.isFinite(data.pendingDebitBalanceCents) &&
      data.pendingDebitBalanceCents !== 0
    )
      windows.push(valueWindow("Pending", money(data.pendingDebitBalanceCents / 100)));
    return [{ ...base, blocked: balance <= 0, windows }];
  },
};
