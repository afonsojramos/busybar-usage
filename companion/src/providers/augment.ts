import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

export const augment: Provider = {
  id: "augment", name: "Augment",
  // Runs the provider's CLI, which is slow; CodexBar refreshes about this often.
  minIntervalSeconds: 300,
  async fetch(context) {
    const now = context.now();
    const base: FeedAccount = {
      provider: "augment", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const cli = await context.run("auggie", ["account", "status"], { timeoutMs: 15_000 });
    if (cli?.code === 0) {
      const text = cli.stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      const num = (s: string | undefined) => s === undefined ? null : finiteNumber(s.replaceAll(",", ""));
      const remaining = num(text.match(/([\d,]+)\s+credits\s+remaining/)?.[1]
        ?? text.match(/([\d,]+)\s+remaining[^\n]*credits used/)?.[1]);
      const usedTotal = text.match(/([\d,]+)\s*\/\s*([\d,]+)\s+credits used/);
      const total = num(usedTotal?.[2] ?? text.match(/([\d,]+)\s+credits\s*\/\s*month/)?.[1]);
      const used = num(usedTotal?.[1]) ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null);
      if (total !== null && total > 0 && used !== null && remaining !== null) {
        const date = text.match(/ends\s+(\d+)\/(\d+)\/(\d{4})/);
        const reset = date ? isoToSeconds(`${date[3]}-${date[1].padStart(2, "0")}-${date[2].padStart(2, "0")}T00:00:00`) : null;
        const windows = [feedWindow(43200, used / total * 100, reset, now)];
        return [{ ...base, windows, blocked: windows.some(w => (w.used_percent ?? 0) >= 100) }];
      }
    }
    const cookie = await cookieHeader(context, "augment", {
      domains: ["augmentcode.com", "app.augmentcode.com"],
      required: ["session", "_session", "web_rpc_proxy_session", "auth0", "auth0.is.authenticated", "a0.spajs.txs",
        "__Secure-next-auth.session-token", "next-auth.session-token", "__Secure-authjs.session-token",
        "__Host-authjs.csrf-token", "authjs.session-token"],
    });
    if (!cookie) {
      if (cli && /Authentication failed|auggie login/.test(cli.stdout + cli.stderr)) return [{ ...base, error: "sign in" }];
      if (cli) throw new HttpError("Augment", 502);
      throw new NotConfigured("Augment");
    }
    async function get(path: string): Promise<unknown> {
      const response = await context.fetch(`https://app.augmentcode.com/api/${path}`, {
        headers: { Cookie: cookie ?? "", Accept: "application/json" },
        signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      if (response.status === 429) throw new RateLimited("Augment", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Augment", response.status);
      try { return await response.json(); } catch { throw new HttpError("Augment", response.status); }
    }
    try {
      const credits = await get("credits");
      if (!isRecord(credits)) throw new HttpError("Augment", 200);
      const remaining = finiteNumber(credits.usageUnitsRemaining);
      const used = finiteNumber(credits.usageUnitsConsumedThisBillingCycle);
      const available = finiteNumber(credits.usageUnitsAvailable);
      const total = available !== null && available > 0 ? available
        : remaining !== null && used !== null ? remaining + used : null;
      if (total === null || total <= 0 || (used === null && remaining === null)) throw new HttpError("Augment", 200);
      const subscription = await get("subscription");
      if (!isRecord(subscription)) throw new HttpError("Augment", 200);
      const spent = used ?? (remaining === null ? 0 : Math.max(0, total - remaining));
      const windows = [feedWindow(43200, spent / total * 100,
        isoToSeconds(subscription.billingPeriodEnd), now)];
      return [{ ...base, account: accountLabel(typeof subscription.email === "string" ? subscription.email : null),
        windows, blocked: windows.some(w => (w.used_percent ?? 0) >= 100) }];
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
