import { accountLabel, feedWindow, isoToSeconds, isRecord, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

function result(root: unknown): Record<string, unknown> | null {
  return isRecord(root) && root.success === true && isRecord(root.result) ? root.result : null;
}

export const abacus: Provider = {
  id: "abacus",
  name: "Abacus",
  async fetch(context): Promise<FeedAccount[]> {
    const cookie = await cookieHeader(context, "abacus", { domains: ["apps.abacus.ai", "abacus.ai"] });
    if (!cookie) throw new NotConfigured("Abacus");
    const now = context.now();
    const base: FeedAccount = {
      provider: "abacus",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const headers = {
      Cookie: cookie.replace(/^cookie:\s*/i, ""),
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    const response = await context.fetch("https://apps.abacus.ai/api/_getOrganizationComputePoints", {
      headers,
      signal: AbortSignal.timeout(30_000),
      redirect: "manual",
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Abacus", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Abacus", response.status);
    let root: unknown;
    try {
      root = await response.json();
    } catch {
      throw new HttpError("Abacus", response.status);
    }
    const points = result(root);
    if (!points) {
      if (
        isRecord(root) &&
        typeof root.error === "string" &&
        /expired|session|login|authenticate|unauthorized|unauthenticated|forbidden/i.test(root.error)
      )
        return [{ ...base, error: "sign in" }];
      throw new HttpError("Abacus", response.status);
    }
    const total = points.totalComputePoints;
    const left = points.computePointsLeft;
    if (typeof total !== "number" || !Number.isFinite(total) || typeof left !== "number" || !Number.isFinite(left))
      throw new HttpError("Abacus", response.status);
    let reset: number | null = null;
    try {
      const billingResponse = await context.fetch("https://apps.abacus.ai/api/_getBillingInfo", {
        method: "POST",
        headers,
        body: "{}",
        signal: AbortSignal.timeout(30_000),
        redirect: "manual",
      });
      if (billingResponse.ok) {
        const billing = result(await billingResponse.json());
        reset = isoToSeconds(billing?.nextBillingDate);
      }
    } catch {
      /* Billing is optional; compute credits remain useful without a reset. */
    }
    const used = total > 0 ? ((total - left) / total) * 100 : 0;
    if (!Number.isFinite(used)) throw new HttpError("Abacus", response.status);
    const window = feedWindow(43200, used, reset, now);
    return [{ ...base, windows: [window], blocked: (window.used_percent ?? 0) >= 100 }];
  },
};
