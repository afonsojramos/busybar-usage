import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";


function apiBase(raw: string | undefined, fallback: string): string {
  try {
    const text = raw?.trim() || fallback;
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new HttpError("Codebuff", 0);
  }
}

function date(value: unknown): number | null {
  const numeric = finiteNumber(value);
  return numeric === null ? isoToSeconds(value) : numeric > 10_000_000_000 ? numeric / 1000 : numeric;
}

const SIGN_IN = Symbol("sign in");

export const codebuff: Provider = {
  id: "codebuff",
  name: "Codebuff",
  async fetch(context): Promise<FeedAccount[]> {
    let key = await apiKey(context, "codebuff", ["CODEBUFF_API_KEY"]);
    let session = false;
    let credentialEmail: string | null = null;
    if (!key) {
      const file = await context.readFile(join(context.home, ".config/manicode/credentials.json"));
      try {
        const credentials: unknown = file === null ? null : JSON.parse(file);
        if (isRecord(credentials)) {
          const profile = isRecord(credentials.default) ? credentials.default : null;
          const profileToken = typeof profile?.authToken === "string" ? profile.authToken.trim() : "";
          const token = profileToken || credentials.authToken;
          if (typeof token === "string" && token.trim()) {
            key = token.trim();
            session = true;
            const email = profileToken ? profile?.email : credentials.email;
            credentialEmail = typeof email === "string" ? email : null;
          }
        }
      } catch {
        key = null;
      }
    }
    if (!key) throw new NotConfigured("Codebuff");
    // The CLI owns this session token; read it without refreshing or writing it.
    const now = context.now();
    const base: FeedAccount = {
      provider: "codebuff", account: accountLabel(credentialEmail), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    async function request(url: string, init: RequestInit = {}): Promise<unknown> {
      const response = await context.fetch(url, {
        ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) return SIGN_IN;
      if (response.status === 429) throw new RateLimited("Codebuff", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Codebuff", response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError("Codebuff", response.status);
      }
    }
    const url = apiBase(context.env.CODEBUFF_API_URL, "https://www.codebuff.com");
    const data = await request(`${url}/api/v1/usage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprintId: "codexbar-usage" }),
    });
    if (data === SIGN_IN) return [{ ...base, error: "sign in" }];
    if (!isRecord(data)) throw new HttpError("Codebuff", 200);
    const used = finiteNumber(data.usage) ?? finiteNumber(data.used);
    const quota = finiteNumber(data.quota) ?? finiteNumber(data.limit);
    const remaining = finiteNumber(data.remainingBalance) ?? finiteNumber(data.remaining);
    const total = quota ?? (used !== null && remaining !== null ? used + remaining : null);
    const spent = used ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : 0);
    if ((total !== null && !Number.isFinite(total)) || !Number.isFinite(spent)) throw new HttpError("Codebuff", 200);
    const windows: FeedWindow[] = [];
    if (total !== null && total > 0) {
      windows.push(feedWindow(null, Math.min(100, Math.max(0, spent / total * 100)), date(data.next_quota_reset), now, "quota"));
    } else if (remaining !== null) windows.push(valueWindow("bal", `${Math.abs(remaining) < 1e6 ? remaining.toFixed(1) : remaining.toExponential(1)} cr`));
    if (windows.length === 0) throw new HttpError("Codebuff", 200);
    if (session) {
      const subscription = await request(`${url}/api/user/subscription`);
      if (subscription === SIGN_IN) return [{ ...base, error: "sign in" }];
      if (!isRecord(subscription)) throw new HttpError("Codebuff", 200);
      const user = isRecord(subscription.user) ? subscription.user : null;
      const email = typeof subscription.email === "string" ? subscription.email
        : typeof user?.email === "string" ? user.email : credentialEmail;
      base.account = accountLabel(email);
      if (isRecord(subscription.rateLimit)) {
        const rate = subscription.rateLimit;
        const weeklyUsed = finiteNumber(rate.weeklyUsed) ?? finiteNumber(rate.used);
        const weeklyLimit = finiteNumber(rate.weeklyLimit) ?? finiteNumber(rate.limit);
        if (weeklyLimit !== null && weeklyLimit > 0) {
          windows.unshift(feedWindow(10080, Math.min(100, Math.max(0, (weeklyUsed ?? 0) / weeklyLimit * 100)),
            date(rate.weeklyResetsAt), now));
        }
      }
    }
    return [{ ...base, blocked: (remaining !== null && remaining <= 0)
      || windows.some((w) => (w.used_percent ?? 0) >= 100), windows }];
  },
};
