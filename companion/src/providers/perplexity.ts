import { accountLabel, feedWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const SESSION_NAMES = [
  "__Secure-authjs.session-token",
  "authjs.session-token",
  "__Secure-next-auth.session-token",
  "next-auth.session-token",
];

function sessionCookies(raw: string): string[] {
  const text = raw.trim().replace(/^cookie:\s*/i, "");
  if (!text.includes("=") && !text.includes(";")) return SESSION_NAMES.map((name) => `${name}=${text}`);
  const pairs = new Map<string, { name: string; value: string }>();
  for (const part of text.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (value) pairs.set(name.toLowerCase(), { name, value });
  }
  for (const name of SESSION_NAMES) {
    const direct = pairs.get(name.toLowerCase());
    if (direct) return [`${direct.name}=${direct.value}`];
    const chunks = [...pairs.entries()]
      .flatMap(([key, pair]) => {
        if (!key.startsWith(`${name.toLowerCase()}.`)) return [];
        const suffix = key.slice(name.length + 1);
        const index = Number(suffix);
        return /^\d+$/.test(suffix) && Number.isSafeInteger(index) ? [{ index, ...pair }] : [];
      })
      .sort((a, b) => a.index - b.index);
    if (chunks.length && chunks.every((chunk, index) => chunk.index === index)) {
      return [
        `${chunks[0].name.slice(0, chunks[0].name.lastIndexOf("."))}=${chunks.map((chunk) => chunk.value).join("")}`,
      ];
    }
  }
  return [];
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError("Perplexity", 200);
  return value;
}

function parseUsage(root: unknown, now: number): { windows: FeedWindow[]; exhausted: boolean } {
  if (!isRecord(root)) throw new HttpError("Perplexity", 200);
  const balance = number(root.balance_cents ?? root.balanceCents);
  const renewal = number(root.renewal_date_ts ?? root.renewalDateTs);
  const purchasedField = number(root.current_period_purchased_cents ?? root.currentPeriodPurchasedCents);
  let usage = number(root.total_usage_cents ?? root.totalUsageCents);
  const grants = root.credit_grants ?? root.creditGrants;
  if (!Array.isArray(grants)) throw new HttpError("Perplexity", 200);
  const pools = { recurring: 0, purchased: 0, promotional: 0 };
  for (const grant of grants) {
    if (!isRecord(grant) || typeof grant.type !== "string") throw new HttpError("Perplexity", 200);
    const amount = number(grant.amount_cents ?? grant.amountCents);
    const expiry = grant.expires_at_ts ?? grant.expiresAtTs;
    if (expiry !== undefined && expiry !== null) number(expiry);
    if (grant.type === "promotional" && typeof expiry === "number" && expiry <= now) continue;
    if (grant.type === "recurring" || grant.type === "purchased" || grant.type === "promotional") {
      pools[grant.type] += amount;
    }
  }
  pools.recurring = Math.max(0, pools.recurring);
  pools.purchased = Math.max(0, pools.purchased, purchasedField);
  pools.promotional = Math.max(0, pools.promotional);
  const windows: FeedWindow[] = [];
  for (const [name, total] of [
    ["Credits", pools.recurring],
    ["Bought", pools.purchased],
    ["Bonus", pools.promotional],
  ] satisfies [string, number][]) {
    const used = Math.min(usage, total);
    usage -= used;
    if (total > 0)
      windows.push(
        feedWindow(
          null,
          Math.max(0, Math.min(100, (used / total) * 100)),
          name === "Credits" ? renewal : null,
          now,
          name,
        ),
      );
  }
  const orgDraws = root.org_pool_draws_cents ?? root.orgPoolDrawsCents;
  const orgCap = root.org_user_cap_cents ?? root.orgUserCapCents;
  const orgDepleted = root.is_org_pool_depleted ?? root.isOrgPoolDepleted;
  if (orgDepleted !== undefined && orgDepleted !== null && typeof orgDepleted !== "boolean")
    throw new HttpError("Perplexity", 200);
  if ((orgDraws !== undefined && orgDraws !== null) || (orgCap !== undefined && orgCap !== null)) {
    const drawn = Math.max(0, orgDraws === undefined || orgDraws === null ? 0 : number(orgDraws));
    if (orgCap !== undefined && orgCap !== null) number(orgCap);
    const personalLeft = Math.max(
      0,
      pools.recurring + pools.purchased + pools.promotional - number(root.total_usage_cents ?? root.totalUsageCents),
    );
    const available = orgDepleted === true ? 0 : Math.max(0, balance - personalLeft);
    const total = drawn + available;
    windows.push(feedWindow(null, total > 0 ? (drawn / total) * 100 : 100, null, now, "Org"));
  }
  if (!windows.length) windows.push(feedWindow(null, 100, renewal, now, "Credits"));
  // CodexBar promotes usable fallback pools after recurring credits have been exhausted.
  const usable = windows.filter((window) => (window.used_percent ?? 0) < 100);
  const exhausted = windows.filter((window) => (window.used_percent ?? 0) >= 100);
  return { windows: [...usable, ...exhausted].slice(0, 2), exhausted: balance <= 0 };
}

export const perplexity: Provider = {
  id: "perplexity",
  name: "Perplexity",
  async fetch(context): Promise<FeedAccount[]> {
    const raw = await cookieHeader(context, "perplexity", {
      domains: ["www.perplexity.ai", "perplexity.ai"],
      envNames: ["PERPLEXITY_SESSION_TOKEN", "perplexity_session_token", "PERPLEXITY_COOKIE"],
    });
    if (!raw) throw new NotConfigured("Perplexity");
    const cookies = sessionCookies(raw);
    if (!cookies.length) throw new NotConfigured("Perplexity");
    const now = context.now();
    const base: FeedAccount = {
      provider: "perplexity",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    for (const cookie of cookies) {
      const response = await context.fetch(
        "https://www.perplexity.ai/rest/billing/credits?version=2.18&source=default",
        {
          headers: {
            Cookie: cookie,
            Origin: "https://www.perplexity.ai",
            Referer: "https://www.perplexity.ai/account/usage",
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
          },
          signal: AbortSignal.timeout(30_000),
          redirect: "manual",
        },
      );
      if (response.status === 401 || response.status === 403) continue;
      if (response.status === 429) throw new RateLimited("Perplexity", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Perplexity", response.status);
      let root: unknown;
      try {
        root = await response.json();
      } catch {
        throw new HttpError("Perplexity", response.status);
      }
      const parsed = parseUsage(root, now);
      return [
        {
          ...base,
          windows: parsed.windows,
          blocked: parsed.exhausted || parsed.windows.some((window) => (window.used_percent ?? 0) >= 100),
        },
      ];
    }
    return [{ ...base, error: "sign in" }];
  },
};
