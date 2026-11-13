import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

type Region = "global" | "bigmodel-cn";
interface Settings {
  region: Region;
  quota: URL;
  balance: URL;
  selectors: Record<string, string>;
  team: boolean;
  email: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function endpoint(raw: string): URL {
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.hash) return url;
  } catch {}
  throw new Error("z.ai endpoint must be a valid HTTPS URL");
}

async function configEntry(context: Context): Promise<Record<string, unknown>> {
  const home = context.env.XDG_CONFIG_HOME || join(context.home, ".config");
  const paths = context.env.CODEXBAR_CONFIG ? [context.env.CODEXBAR_CONFIG]
    : [join(home, "codexbar", "config.json"), join(context.home, ".codexbar", "config.json")];
  for (const path of paths) {
    const file = await context.readFile(path);
    if (!file) continue;
    let root: unknown;
    try { root = JSON.parse(file); } catch { continue; }
    if (!isRecord(root)) continue;
    const providers = Array.isArray(root.providers) ? root.providers : [];
    const entry = providers.find((item) => isRecord(item) && item.id === "zai");
    return isRecord(entry) ? entry : {};
  }
  return {};
}

async function settings(context: Context): Promise<Settings> {
  const entry = await configEntry(context);
  const quotaOverride = text(context.env.Z_AI_QUOTA_URL);
  const hostOverride = text(context.env.Z_AI_API_HOST);
  const override = quotaOverride ? endpoint(quotaOverride) : hostOverride ? endpoint(hostOverride) : null;
  const configuredRegion = text(entry.region);
  const region = configuredRegion ?? (override?.hostname === "open.bigmodel.cn" ? "bigmodel-cn" : "global");
  if (region !== "global" && region !== "bigmodel-cn") throw new Error("z.ai API region is invalid");
  const host = region === "global" ? "api.z.ai" : "open.bigmodel.cn";
  if (override && ["api.z.ai", "open.bigmodel.cn"].includes(override.hostname) && override.hostname !== host) {
    throw new Error("z.ai endpoint does not match the selected region");
  }
  const quota = override ?? new URL(`https://${host}/api/monitor/usage/quota/limit`);
  if (!quotaOverride && (quota.pathname === "/" || quota.pathname === "")) quota.pathname = "/api/monitor/usage/quota/limit";
  const balanceOverride = text(context.env.Z_AI_BALANCE_URL);
  const balance = endpoint(balanceOverride ?? "https://www.bigmodel.cn/api/biz/account/query-customer-account-report");
  const accounts = isRecord(entry.tokenAccounts) ? entry.tokenAccounts : {};
  const list = Array.isArray(accounts.accounts) ? accounts.accounts : [];
  const index = typeof accounts.activeIndex === "number" ? accounts.activeIndex : 0;
  const selected = isRecord(list[index]) ? list[index] : {};
  const scope = text(selected.usageScope)?.toLowerCase() ?? "personal";
  if (scope !== "personal" && scope !== "team") throw new Error("z.ai usage scope is invalid");
  const selectors: Record<string, string> = {};
  if (scope === "team") {
    const organization = text(selected.organizationId) ?? text(selected.organizationID) ?? text(context.env.Z_AI_BIGMODEL_ORGANIZATION);
    const project = text(selected.workspaceID) ?? text(context.env.Z_AI_BIGMODEL_PROJECT);
    if (!organization || !project || /[\r\n]/.test(organization + project)) {
      throw new Error("z.ai team scope requires single-line organization and project IDs");
    }
    selectors["Bigmodel-Organization"] = organization;
    selectors["Bigmodel-Project"] = project;
    quota.searchParams.set("type", "2");
  }
  return { region, quota, balance, selectors, team: scope === "team", email: text(selected.email) };
}

interface Limit {
  kind: "plan" | "mcp";
  window: FeedWindow;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function parseLimits(root: unknown, now: number): Limit[] | null {
  if (!isRecord(root) || root.success !== true || root.code !== 200 || !isRecord(root.data) || !Array.isArray(root.data.limits)) return null;
  const limits: Limit[] = [];
  for (const raw of root.data.limits) {
    if (isRecord(raw) && typeof raw.type === "string" && !["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(raw.type)) continue;
    if (!isRecord(raw) || !["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(String(raw.type))) return null;
    const unit = integer(raw.unit);
    const count = integer(raw.number);
    let percent = integer(raw.percentage);
    if (unit === null || count === null || percent === null) return null;
    for (const field of ["usage", "currentValue", "remaining", "nextResetTime"]) {
      if (raw[field] !== null && raw[field] !== undefined && integer(raw[field]) === null) return null;
    }
    if (raw.usageDetails !== null && raw.usageDetails !== undefined && !Array.isArray(raw.usageDetails)) return null;
    const total = integer(raw.usage);
    const current = integer(raw.currentValue);
    const remaining = integer(raw.remaining);
    if (total !== null && total > 0) {
      const used = remaining !== null ? Math.max(total - remaining, current ?? total - remaining) : current;
      if (used !== null) percent = Math.max(0, Math.min(total, used)) / total * 100;
    }
    const multiplier = unit === 1 ? 1440 : unit === 3 ? 60 : unit === 5 ? 1 : unit === 6 ? 10080 : null;
    const mcp = raw.type === "TIME_LIMIT";
    const minutes = mcp && unit === 5 && count === 1 ? 43200 : multiplier !== null && count > 0 ? count * multiplier : null;
    let reset = integer(raw.nextResetTime);
    // Five-hour resets beyond the window are incompatible; do not guess a timezone correction.
    if (!mcp && minutes === 300 && reset !== null && reset > (now + 18060) * 1000) reset = null;
    limits.push({ kind: mcp ? "mcp" : "plan", window: feedWindow(minutes, Math.max(0, Math.min(100, percent)), reset === null ? null : reset / 1000, now, minutes === null ? mcp ? "MCP" : "quota" : undefined) });
  }
  return limits;
}

function selectedWindows(limits: Limit[]): FeedWindow[] {
  const order = (a: FeedWindow, b: FeedWindow) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity);
  const plan = limits.filter((limit) => limit.kind === "plan").map((limit) => limit.window).sort(order);
  const mcp = limits.filter((limit) => limit.kind === "mcp").at(-1)?.window;
  const first = plan[0];
  const last = plan.at(-1);
  if (plan.length >= 2 && first && last) return [first, last];
  return [...plan, ...(mcp ? [mcp] : [])].sort(order);
}

export const zai: Provider = {
  id: "zai",
  name: "z.ai",
  async fetch(context): Promise<FeedAccount[]> {
    const config = await settings(context);
    const envNames = config.region === "global" ? ["Z_AI_API_KEY"]
      : ["Z_AI_API_KEY", "BIGMODEL_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"];
    let key = await apiKey(context, "zai", envNames);
    if (!key && config.region === "bigmodel-cn") {
      for (const relative of [".coding-relay/glm-api-key", ".config/bigmodel/api_key", ".config/zhipu/api_key"]) {
        const file = await context.readFile(join(context.home, relative));
        key = text(file?.split(/[\r\n]+/).find((line) => line.length > 0));
        if (key) break;
      }
    }
    if (!key) throw new NotConfigured("z.ai");
    const now = context.now();
    const base: FeedAccount = {
      provider: "zai", account: accountLabel(config.email), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [],
    };
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json", ...config.selectors };
    const response = await context.fetch(config.quota, { headers, signal: AbortSignal.timeout(30_000) });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("z.ai", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("z.ai", response.status);
    let root: unknown;
    try { root = await response.json(); } catch { throw new HttpError("z.ai", response.status); }
    const dataEmail = isRecord(root) && isRecord(root.data) ? text(root.data.email) : null;
    const email = config.email ?? (isRecord(root) ? text(root.email) : null) ?? dataEmail;
    const identified = { ...base, account: accountLabel(email) };
    const noPlan = config.region === "bigmodel-cn" && !config.team && isRecord(root)
      && root.success === false && root.code === 500 && root.msg === "当前用户不存在coding plan";
    if (noPlan) {
      const balance = await context.fetch(config.balance, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (balance.status === 401 || balance.status === 403) return [{ ...identified, error: "sign in" }];
      if (balance.status === 429) throw new RateLimited("z.ai", now + retryAfterSeconds(balance.headers, 300));
      if (!balance.ok) throw new HttpError("z.ai", balance.status);
      let body: unknown;
      try { body = await balance.json(); } catch { throw new HttpError("z.ai", balance.status); }
      const data = isRecord(body) && body.success === true && isRecord(body.data) ? body.data : null;
      const amount = data ? finiteNumber(data.availableBalance) ?? finiteNumber(data.balance) : null;
      if (amount === null) throw new HttpError("z.ai", balance.status);
      const value = `¥${amount.toFixed(2)}`;
      const compact = value.length <= 12 ? value : `¥${amount.toExponential(2)}`;
      return [{ ...identified, account: accountLabel(email ?? (isRecord(body) ? text(body.email) : null) ?? (data ? text(data.email) : null)), blocked: amount <= 0, windows: [valueWindow("CNY", compact)] }];
    }
    const limits = parseLimits(root, now);
    if (!limits) throw new HttpError("z.ai", response.status);
    if (!limits.length) return [{ ...identified, error: "no quota" }];
    return [{ ...identified, blocked: limits.some((limit) => (limit.window.used_percent ?? 0) >= 100), windows: selectedWindows(limits) }];
  },
};
