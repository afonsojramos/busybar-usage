import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const PROCEDURES = ["user.getCreditBlocks", "kiloPass.getState", "user.getAutoTopUpPaymentMethod"];

async function cliToken(context: Context): Promise<string | null> {
  const text = await context.readFile(join(context.home, ".local/share/kilo/auth.json"));
  if (!text) return null;
  try {
    const data: unknown = JSON.parse(text);
    const kilo = isRecord(data) ? data.kilo : null;
    return isRecord(kilo) && typeof kilo.access === "string" ? kilo.access.trim() || null : null;
  } catch {
    return null;
  }
}

function contexts(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const result = [value];
  let level = [value];
  for (let depth = 0; depth < 2; depth++) {
    const next = level.flatMap((entry) => Object.values(entry).flatMap((item) =>
      isRecord(item) ? [item] : Array.isArray(item) ? item.filter(isRecord) : []));
    result.push(...next);
    level = next;
  }
  return result;
}

function number(records: Record<string, unknown>[], keys: string[]): number | null {
  for (const record of records) {
    for (const key of keys) {
      const value = finiteNumber(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function money(records: Record<string, unknown>[], cents: string[], micro: string[], plain: string[]): number | null {
  const centValue = number(records, cents);
  if (centValue !== null) return centValue / 100;
  const microValue = number(records, micro);
  return microValue === null ? number(records, plain) : microValue / 1_000_000;
}

function payload(entry: unknown): unknown {
  if (!isRecord(entry) || !isRecord(entry.result)) return null;
  const result = entry.result;
  return isRecord(result.data) ? ("json" in result.data ? result.data.json : result.data) : result.json;
}

function trpcStatus(entry: unknown): number | null {
  if (!isRecord(entry) || !isRecord(entry.error)) return null;
  const values = contexts(entry.error).flatMap((record) => [record.code, record.message])
    .filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
  if (values.includes("unauthorized")) return 401;
  if (values.includes("forbidden")) return 403;
  return 200;
}

function date(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric === null ? isoToSeconds(value) : numeric > 1e12 ? numeric / 1000 : numeric;
}

function dollars(value: number): string {
  return value < 1e9 ? `$${value.toFixed(2)}` : `$${value.toExponential(2)}`;
}

function parseUsage(root: unknown, now: number): { windows: FeedWindow[]; blocked: boolean } | null {
  const entries = Array.isArray(root) ? root : isRecord(root)
    ? ("result" in root || "error" in root ? [root] : [root["0"], root["1"], root["2"]]) : [];
  const credits = contexts(payload(entries[0]));
  const pass = payload(entries[1]);
  if (!credits.length && !isRecord(pass)) return null;
  const windows: FeedWindow[] = [];
  let exhaustedBalance = false;
  const blocks = credits.map((entry) => entry.creditBlocks).find(Array.isArray);
  let total: number | null = null;
  let remaining: number | null = null;
  if (blocks) {
    const amounts = blocks.filter(isRecord).map((entry) => finiteNumber(entry.amount_mUsd)).filter((n) => n !== null);
    const balances = blocks.filter(isRecord).map((entry) => finiteNumber(entry.balance_mUsd)).filter((n) => n !== null);
    if (amounts.length) total = amounts.reduce((a, b) => a + b, 0) / 1_000_000;
    if (balances.length) remaining = balances.reduce((a, b) => a + b, 0) / 1_000_000;
  }
  let used = number(credits, ["used", "usedCredits", "consumed", "spent", "creditsUsed"]);
  total ??= number(credits, ["total", "totalCredits", "creditsTotal", "limit"]);
  remaining ??= number(credits, ["remaining", "remainingCredits", "creditsRemaining"]);
  if (total === null && used !== null && remaining !== null) total = used + remaining;
  if (used === null && total !== null && remaining !== null) used = Math.max(0, total - remaining);
  if (total !== null && Number.isFinite(total) && used !== null && Number.isFinite(used)) {
    windows.push(feedWindow(null, total > 0 ? Math.min(100, used / total * 100) : 100, null, now, "credit"));
  } else {
    const balance = remaining ?? money(credits, [], ["totalBalance_mUsd"], []);
    if (balance !== null && Number.isFinite(balance)) {
      windows.push(valueWindow("credit", dollars(Math.max(0, balance))));
      exhaustedBalance = balance <= 0;
    }
  }
  if (isRecord(pass)) {
    const subscription = isRecord(pass.subscription) ? pass.subscription : pass.subscription === null ? null :
      ["currentPeriodUsageUsd", "currentPeriodBaseCreditsUsd", "currentPeriodBonusCreditsUsd", "tier"]
        .some((key) => key in pass) ? pass : null;
    const records = contexts(pass);
    const passUsed = subscription ? finiteNumber(subscription.currentPeriodUsageUsd) : money(records,
      ["usedCents", "spentCents", "consumedCents", "usedAmountCents", "consumedAmountCents"],
      ["used_mUsd", "spent_mUsd", "consumed_mUsd", "usedAmount_mUsd"],
      ["used", "spent", "consumed", "usage", "creditsUsed", "usedAmount", "consumedAmount"]);
    const base = subscription ? finiteNumber(subscription.currentPeriodBaseCreditsUsd) : null;
    const passTotal = subscription ? base === null ? null : Math.max(0, base) + Math.max(0, finiteNumber(subscription.currentPeriodBonusCreditsUsd) ?? 0) : money(records,
      ["amountCents", "totalCents", "planAmountCents", "monthlyAmountCents", "limitCents", "includedCents", "valueCents"],
      ["amount_mUsd", "total_mUsd", "planAmount_mUsd", "limit_mUsd", "included_mUsd", "value_mUsd"],
      ["amount", "total", "limit", "included", "value", "creditsTotal", "totalCredits", "planAmount"]);
    const passRemaining = money(records,
      ["remainingCents", "remainingAmountCents", "availableCents", "leftCents", "balanceCents"],
      ["remaining_mUsd", "available_mUsd", "left_mUsd", "balance_mUsd"],
      ["remaining", "available", "left", "balance", "creditsRemaining", "remainingAmount", "availableAmount"]);
    const resolvedTotal = passTotal ?? (passUsed !== null && passRemaining !== null ? passUsed + passRemaining : null);
    const resolvedUsed = passUsed ?? (resolvedTotal !== null && passRemaining !== null ? Math.max(0, resolvedTotal - passRemaining) : null);
    const resetKeys = ["nextBillingAt", "nextRenewalAt", "renewsAt", "renewAt", "resetAt", "resetsAt", "nextResetAt", "currentPeriodEnd", "periodEndsAt", "expiresAt", "expiryAt"];
    const reset = subscription
      ? ["nextBillingAt", "nextRenewalAt", "renewsAt", "renewAt"]
        .map((key) => date(subscription[key])).find((value) => value !== null) ?? null
      : records.flatMap((record) => resetKeys.map((key) => date(record[key]))).find((value) => value !== null) ?? null;
    if (resolvedTotal !== null && Number.isFinite(resolvedTotal) && resolvedUsed !== null && Number.isFinite(resolvedUsed)) {
      windows.unshift(feedWindow(null, resolvedTotal > 0 ? Math.min(100, resolvedUsed / resolvedTotal * 100) : 100, reset, now, "pass"));
    }
  }
  return windows.length ? { windows, blocked: exhaustedBalance || windows.some((window) => (window.used_percent ?? 0) >= 100) } : null;
}

export const kilo: Provider = {
  id: "kilo",
  name: "Kilo",
  async fetch(context) {
    const key = await apiKey(context, "kilo", ["KILO_API_KEY"]);
    const cli = await cliToken(context);
    const token = key ?? cli;
    if (!token) throw new NotConfigured("Kilo");
    const now = context.now();
    const base = { provider: "kilo", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [] };
    const url = new URL(`https://app.kilo.ai/api/trpc/${PROCEDURES.join(",")}`);
    url.searchParams.set("batch", "1");
    url.searchParams.set("input", JSON.stringify(Object.fromEntries(PROCEDURES.map((_, index) => [index, { json: null }]))));
    async function request(bearer: string): Promise<Response> {
      return context.fetch(url, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000) });
    }
    let response = await request(token);
    let body: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (response.status === 429) throw new RateLimited("Kilo", now + retryAfterSeconds(response.headers, 300));
      let status = response.status;
      if (response.ok) {
        try { body = await response.json(); } catch { throw new HttpError("Kilo", status); }
        const entries = Array.isArray(body) ? body : isRecord(body) ? ("result" in body || "error" in body ? [body] : [body["0"], body["1"]]) : [];
        const error = entries.slice(0, 2).map(trpcStatus).find((value) => value !== null);
        if (error !== undefined) status = error;
        else break;
      }
      if (status === 401 || status === 403) {
        if (attempt === 0 && key && cli && cli !== key) { response = await request(cli); continue; }
        return [{ ...base, error: "sign in" }];
      }
      throw new HttpError("Kilo", status);
    }
    const usage = parseUsage(body, now);
    if (usage === null) throw new HttpError("Kilo", response.status);
    return [{ ...base, ...usage }];
  },
};
