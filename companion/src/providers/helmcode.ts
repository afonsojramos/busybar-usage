import { cookieHeader } from "../cookies.ts";
import { accountLabel, feedWindow, isRecord, isoToSeconds, valueWindow, type FeedWindow } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new HttpError("Helmcode", 200);
  return value;
}
function money(amount: number, currency: string): string {
  const prefix = currency === "EUR" ? "€" : currency === "USD" ? "$" : currency;
  const fixed = `${prefix}${amount.toFixed(2)}`;
  return fixed.length <= 12 ? fixed : `${prefix}${amount.toExponential(2)}`.slice(0, 12);
}

export const helmcode: Provider = {
  id: "helmcode", name: "Helmcode",
  async fetch(context) {
    const entry = await providerEntry(context, "helmcode");
    if (entry.cookieSource === "off") throw new NotConfigured("Helmcode");
    const saved = typeof entry.cookieHeader === "string" && entry.cookieHeader.trim() !== "";
    const tenants = saved ? [entry.region === "nanBuilders" ? "nan.builders" : "helmcode.com"]
      : ["helmcode.com", "nan.builders"];
    const now = context.now();
    const base = { provider: "helmcode", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [] };
    let rejected = false;
    for (const tenant of tenants) {
      const raw = await cookieHeader(context, "helmcode", {
        domains: tenant === "helmcode.com" ? ["cloud-api.helmcode.com", "helmcode.com"] : ["nan.builders"],
      });
      if (!raw) continue;
      const headers = { Cookie: raw.replace(/^Cookie:\s*/i, "").trim(), Origin: `https://cloud.${tenant}`,
        Referer: `https://cloud.${tenant}/dashboard` };
      const get = (path: string) => context.fetch(`https://cloud-api.${tenant}${path}`, {
        headers, signal: AbortSignal.timeout(30_000), redirect: "manual",
      });
      const response = await get("/api/usage/quota");
      if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
        rejected = true;
        continue;
      }
      if (response.status === 429) throw new RateLimited("Helmcode", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Helmcode", response.status);
      let quota: unknown;
      try { quota = await response.json(); } catch { throw new HttpError("Helmcode", response.status); }
      if (!isRecord(quota) || typeof quota.periodStart !== "string" || !Array.isArray(quota.models)) {
        throw new HttpError("Helmcode", response.status);
      }
      const optional = async (path: string): Promise<unknown> => {
        try { const result = await get(path); return result.ok ? await result.json() : null; } catch { return null; }
      };
      const billing = await optional("/api/billing");
      const premium = isRecord(billing) && isRecord(billing.subscription) && billing.subscription.premium === true;
      const start = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(quota.periodStart);
      const month = Number(start?.[2]);
      const day = Number(start?.[3]);
      const fallback = start && month >= 1 && month <= 12 && day >= 1 && day <= 31
        ? Date.UTC(Number(start[1]), month, 1) / 1000 : null;
      const models = quota.models.map((row: unknown) => {
        if (!isRecord(row) || typeof row.model !== "string" || row.model.trim() === "" || /[\r\n\x00-\x1f]/.test(row.model)) {
          throw new HttpError("Helmcode", 200);
        }
        const cap = integer(row.cap);
        const used = integer(row.tokensUsed);
        if (row.creditTokens != null) integer(row.creditTokens);
        const hours = row.windowHours == null ? null : integer(row.windowHours);
        if (hours !== null && (hours < 1 || hours > 8760)) throw new HttpError("Helmcode", 200);
        return { name: row.model, cap, used, hours, reset: isoToSeconds(row.periodEnd) ?? fallback };
      }).filter((row) => row.cap > 0 && (row.hours === null || premium));
      models.sort((a, b) => b.used / b.cap - a.used / a.cap || a.name.localeCompare(b.name));
      const selected = models.slice(0, 2).sort((a, b) => (a.hours ?? 720) - (b.hours ?? 720));
      const windows: FeedWindow[] = selected.map((row) => feedWindow(row.hours === null ? 43200 : row.hours * 60,
        row.used / row.cap * 100, row.reset, now, row.hours === null ? "30d" : undefined));
      if (tenant === "helmcode.com") {
        const credits = await optional("/api/billing/credits");
        if (windows.length < 2 && isRecord(credits) && typeof credits.balanceMicros === "number" &&
            Number.isSafeInteger(credits.balanceMicros)) {
          const currency = credits.currency == null ? "EUR"
            : typeof credits.currency === "string" ? credits.currency.toUpperCase() : "";
          if (/^[A-Z]{3}$/.test(currency)) windows.push(valueWindow("balance", money(Math.max(0, credits.balanceMicros / 1e6), currency)));
        }
      }
      return [{ ...base, blocked: models.some((row) => row.used >= row.cap && (row.reset === null || row.reset > now)), windows }];
    }
    if (rejected) return [{ ...base, error: "sign in" }];
    throw new NotConfigured("Helmcode");
  },
};
