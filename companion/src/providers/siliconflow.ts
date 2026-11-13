import { accountLabel, finiteNumber, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, isProviderHost, type Provider } from "./types.ts";

const ID = "siliconflow";
const NAME = "SiliconFlow";
const fail = (): never => {
  throw new HttpError(NAME, 200);
};
function number(value: unknown, strings = true, negative = false): number {
  const parsed = strings ? finiteNumber(value) : typeof value === "number" && Number.isFinite(value) ? value : null;
  if (parsed === null || (!negative && parsed < 0)) return fail();
  return parsed;
}
function compact(value: number): string {
  const text = new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
  return text.length <= 8 ? text : value.toExponential(0);
}
function money(value: number, currency = "USD"): string {
  const prefix = currency === "USD" ? "$" : currency === "CNY" ? "¥" : currency + " ";
  const text = prefix + value.toFixed(2);
  return text.length <= 12 ? text : prefix + compact(value);
}

export const siliconflow: Provider = {
  id: ID,
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: ID,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const key = await apiKey(context, ID, ["SILICONFLOW_API_KEY"]);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!key) throw new NotConfigured(NAME);
    headers.Authorization = `Bearer ${key}`;
    const entry = await providerEntry(context, ID);
    let origin: URL;
    try {
      origin = new URL(
        String(entry.enterpriseHost ?? context.env.SILICONFLOW_BASE_URL ?? "https://api.siliconflow.cn"),
      );
    } catch {
      throw new NotConfigured(NAME);
    }
    if (
      !isProviderHost(origin, ["api.siliconflow.cn", "api.siliconflow.com"]) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !["", "v1"].includes(origin.pathname.replace(/^\/+|\/+$/g, ""))
    )
      throw new NotConfigured(NAME);
    const currency = origin.hostname.endsWith(".cn") ? "CNY" : "USD";
    const get = async (url: string, additions: Record<string, string> = {}): Promise<unknown> => {
      const response = await context.fetch(url, {
        headers: { ...headers, ...additions },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited(NAME, now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError(NAME, response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError(NAME, response.status);
      }
    };
    try {
      const body = await get(`${origin.origin}/v1/user/info`);
      if (!isRecord(body)) return fail();
      const windows: FeedWindow[] = [];
      if (body.code === 30014) throw new SignIn();
      if (body.code !== 20000 || body.status !== true || !isRecord(body.data)) return fail();
      const data = body.data;
      const amount = (value: unknown): number => {
        if (typeof value === "string" && !/^-?\d+(?:\.\d+)?$/.test(value)) return fail();
        return number(value, true, true);
      };
      const balance = amount(data.totalBalance);
      const purchased = data.chargeBalance == null ? null : amount(data.chargeBalance);
      if (data.balance != null) amount(data.balance);
      if (data.status != null && (typeof data.status !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(data.status)))
        return fail();
      windows.push(valueWindow("Balance", money(balance, currency)));
      if (purchased !== null) windows.push(valueWindow("Bought", money(purchased, currency)));
      base.blocked = balance <= 0;
      return [
        {
          ...base,
          blocked: base.blocked || windows.some((w) => (w.used_percent ?? 0) >= 100),
          windows,
        },
      ];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};

class SignIn extends Error {}
