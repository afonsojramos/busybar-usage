import { accountLabel, feedWindow, isRecord, isoToSeconds, valueWindow, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "workbuddy";
const NAME = "WorkBuddy";
const invalid = (): never => { throw new HttpError(NAME, 200); };
const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : invalid();
const numeric = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : invalid();
const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const compact = (value: number): string => Math.abs(value) >= 1e12 ? value.toExponential(1) : new Intl.NumberFormat("en-US", {
  notation: "compact", maximumFractionDigits: 2,
}).format(value);

async function request(context: Context, url: string, headers: Record<string, string>, body?: unknown,
  signal = AbortSignal.timeout(30_000)): Promise<unknown> {
  const response = await context.fetch(url, {
    method: body === undefined ? "GET" : "POST", redirect: "manual",
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal,
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try { return await response.json(); } catch { throw new HttpError(NAME, response.status); }
}

export const workbuddy: Provider = {
  id: ID, name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, ID);
    if (entry.cookieSource === "off") throw new NotConfigured(NAME);
    const base: FeedAccount = {
      provider: ID, account: accountLabel(null), blocked: false,
      observed_at: new Date(context.now() * 1000).toISOString(), windows: [],
    };
    const override = entry.cookieSource === "manual" ? text(entry.workBuddyUserAgent) : null;
    if (typeof entry.workBuddyUserAgent === "string" && /[^\x20-\x7e]/.test(entry.workBuddyUserAgent)) throw new NotConfigured(NAME);
    let major: number | null = null;
    if (!override && context.platform === "darwin") {
      for (const app of ["/Applications/Google Chrome.app", `${context.home}/Applications/Google Chrome.app`]) {
        const plist = await context.readFile(`${app}/Contents/Info.plist`);
        const version = plist?.match(/<key>CFBundleShortVersionString<\/key>\s*<string>(\d+)\.[^<]*<\/string>/)?.[1];
        if (version && Number(version) > 1) { major = Number(version); break; }
      }
    }
    const agents: (string | null)[] = override ? [override] : major ? [major, major - 1].map(version =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`) : [null];
    const cookie = await cookieHeader(context, ID, { domains: ["workbuddy.cn", "www.workbuddy.cn"] });
    if (!cookie) throw new NotConfigured(NAME);
    const headers: Record<string, string> = { Cookie: cookie, Origin: "https://www.workbuddy.cn",
      Referer: "https://www.workbuddy.cn/profile/plans-usage" };
    const post = async (path: string, body: unknown, signal?: AbortSignal) => {
      const root = object(await request(context, `https://www.workbuddy.cn/billing/meter/${path}`, headers, body, signal));
      if (root.code !== 0) return invalid();
      return object(root.data);
    };
    const amount = (value: unknown): number => {
      if (typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())) value = Number(value);
      const number = numeric(value);
      return number >= 0 ? number : invalid();
    };
    try {
      let summary: Record<string, unknown> | null = null;
      for (const agent of agents) {
        if (agent) headers["User-Agent"] = agent;
        try { summary = await post("get-user-resource-summary", {}); break; }
        catch (error) { if (!(error instanceof HttpError && error.status === 401)) throw error; }
      }
      if (!summary) return [{ ...base, error: "sign in" }];
      if (!Array.isArray(summary.Packages)) return invalid();
      let total = 0, remaining = 0, rewardTotal = 0, rewardRemaining = 0;
      for (const raw of summary.Packages) {
        const item = object(raw);
        if (item.CapacityUnit !== "credits") continue;
        total += amount(item.CycleTotalCapacity); remaining += amount(item.CycleRemainCapacity);
        if (item.CycleFrozenCapacity !== undefined) amount(item.CycleFrozenCapacity);
      }
      if (!Number.isFinite(total) || !Number.isFinite(remaining)) return invalid();
      for (const raw of Array.isArray(summary.CreditGroups) ? summary.CreditGroups : []) {
        if (!isRecord(raw) || raw.Kind !== "benefit" || raw.CapacityUnit !== "credits") continue;
        try { const t = amount(raw.CycleTotalCapacity), r = amount(raw.CycleRemainCapacity);
          rewardTotal += t; rewardRemaining += r; } catch { /* Optional reward groups do not invalidate totals. */ }
      }
      if (!Number.isFinite(rewardTotal) || !Number.isFinite(rewardRemaining)) return invalid();
      let reset: number | null = null;
      const deadline = AbortSignal.timeout(5000);
      for (const [kind, codes] of [["paid", PAID_CODES], ["free", FREE_CODES]] as const) {
        if (kind === "free" && reset !== null && rewardTotal <= 0) break;
        try {
          const listing = await post(`get-user-resource-${kind}-packages`,
            { PageNumber: 1, PageSize: 100, PackageCodes: codes, Status: [0, 3] },
            AbortSignal.any([AbortSignal.timeout(30_000), deadline]));
          let earliest: number | null = null;
          for (const row of Array.isArray(listing.Accounts) ? listing.Accounts.slice(0, 100) : []) {
            if (!isRecord(row) || row.CapacityUnit !== "credits" || row.PackageCode === "TCACA_code_007_nzdH5h4Nl0") continue;
            const match = text(row.CycleEndTime)?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/);
            const end = match ? isoToSeconds(`${match[1]}T${match[2]}+08:00`) : null;
            if (end !== null && end + 1 > context.now()) earliest = Math.min(earliest ?? Infinity, end + 1);
          }
          reset ??= earliest;
        } catch { /* Listing failure must not discard the required balance. */ }
      }
      const windows = total > 0 ? [feedWindow(null, Math.max(0, (1 - remaining / total) * 100), reset, context.now(), "Credits")]
        : [valueWindow("Credits", `${compact(remaining)} cr`)];
      if (rewardTotal > 0) windows.push(feedWindow(null, Math.max(0, (1 - rewardRemaining / rewardTotal) * 100), null, context.now(), "Rewards"));
      return [{ ...base, blocked: remaining <= 0 || windows.some(w => (w.used_percent ?? 0) >= 100), windows }];
    } catch (error) {
      if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};

const PAID_CODES = ["TCACA_code_002_AkiJS3ZHF5", "TCACA_code_005_maRGyrHhw1", "TCACA_code_003_FAnt7lcmRT",
  "TCACA_code_023_4xbGhMrE6q", "TCACA_code_026_BaESVICNoi", "TCACA_code_027_0FCGVA6vSa",
  "TCACA_code_009_0XmEQc2xOf", "TCACA_code_038_OhvqZtiPKr", "TCACA_code_036_lupO5WgNdG"];
const FREE_CODES = ["TCACA_code_001_PqouKr6QWV", "TCACA_code_008_cfWoLwvjU4", "TCACA_code_035_ArVxJcGDsm",
  "TCACA_code_006_DbXS0lrypC", "TCACA_code_039_KRcQj7wUat", "TCACA_code_040_mi9rCYg46x",
  "TCACA_code_007_nzdH5h4Nl0", "TCACA_code_028_NtpWi0jzXs", "TCACA_code_037_WxOD3MpI2o",
  "TCACA_code_029_6wCGEWquYy", "TCACA_code_030_BjSt89qTvr"];
