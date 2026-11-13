import { accountLabel, feedWindow, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "traecn";
const NAME = "Trae CN";
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

export const traecn: Provider = {
  id: ID, name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, ID);
    if (entry.cookieSource === "off") throw new NotConfigured(NAME);
    const base: FeedAccount = {
      provider: ID, account: accountLabel(null), blocked: false,
      observed_at: new Date(context.now() * 1000).toISOString(), windows: [],
    };
    const cookie = await cookieHeader(context, ID, { domains: ["trae.cn", "api.trae.cn"] });
    if (!cookie) throw new NotConfigured(NAME);
    const headers = { Cookie: cookie, Origin: "https://www.trae.cn", Referer: "https://www.trae.cn/" };
    try {
      const login = object(await request(context, "https://api.trae.cn/cloudide/api/v3/common/GetUserToken", headers, {}));
      const token = text(object(login.Result).Token);
      if (!token) return invalid();
      const usage = object(await request(context, "https://api.trae.cn/trae/api/v2/pay/user_current_entitlement_list",
        { ...headers, Authorization: `Cloud-IDE-JWT ${token}` }, { require_usage: true, full_data: true }));
      if (usage.code === 1001) return [{ ...base, error: "sign in" }];
      if (usage.is_credits_billing !== true) return invalid();
      const summary = object(usage.usage_summary);
      const total = numeric(summary.total_amount), used = numeric(summary.consumed_amount);
      if (total < 0 || used < 0) return invalid();
      const windows = total > 0 ? [feedWindow(null, Math.min(100, used / total * 100), null, context.now(), "Credits")]
        : [valueWindow("Credits", `${compact(Math.max(0, total - used))} cr`)];
      return [{ ...base, blocked: used >= total, windows }];
    } catch (error) {
      if (error instanceof HttpError && ([401, 403].includes(error.status) || (error.status >= 300 && error.status < 400)))
        return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
