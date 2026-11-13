import { cookieHeader } from "../cookies.ts";
import { join } from "node:path";
import { accountLabel, feedWindow, valueWindow, isoToSeconds, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "huggingface";
const NAME = "Hugging Face";
const identities = new WeakMap<Context, { token: string; fetchedAt: number; profile: Record<string, unknown> }>();
function fail(): never { throw new HttpError(NAME, 200); }
function object(value: unknown): Record<string, unknown> { return isRecord(value) ? value : fail(); }
function usd(value: number): string {
  const text = `$${value.toFixed(2)}`;
  return text.length <= 12 ? text : `$${value.toExponential(3)}`;
}
function account(context: Context, windows: FeedWindow[], email?: unknown): FeedAccount[] {
  return [{
    provider: ID, account: accountLabel(typeof email === "string" ? email : null),
    observed_at: new Date(context.now() * 1000).toISOString(), windows,
    blocked: windows.some(w => (w.used_percent ?? 0) >= 100)
  }];
}
async function read(context: Context, url: string, key: string, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const response = await context.fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...headers },
    redirect: "error", signal: AbortSignal.timeout(30_000)
  });
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  try { return object(await response.json()); } catch { throw new HttpError(NAME, response.status); }
}
function walletBalance(html: string): number {
  const current: unknown[] = [], legacy: unknown[] = [];
  const entities: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: "\u00a0", quot: '"' };
  const decode = (raw: string) => raw.replace(/&([^;]*);/g, (_, entity: string) => {
    if (entities[entity] !== undefined) return entities[entity];
    const n = /^#x[0-9a-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : /^#[0-9]+$/.test(entity) ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > 0x10ffff || n >= 0xd800 && n <= 0xdfff) return fail();
    return String.fromCodePoint(n);
  });
  for (const tag of html.match(/<div\b[^>]*>/gi) ?? []) {
    const props = /\bdata-props\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (!props) continue;
    const payload: unknown = JSON.parse(decode(props[1] ?? props[2] ?? props[3] ?? ""));
    if (!isRecord(payload)) continue;
    if (isRecord(payload.entity) && Object.hasOwn(payload.entity, "currentBalanceUsd")) {
      if (payload.entity.type !== "user") return fail();
      current.push(payload.entity.currentBalanceUsd);
    }
    if (Object.hasOwn(payload, "invoiceCreditsCents")) legacy.push(payload.invoiceCreditsCents);
  }
  const values = current.length ? current : legacy;
  if (values.length !== 1 || typeof values[0] !== "number" || !Number.isFinite(values[0]) || values[0] < 0) return fail();
  if (!current.length && !Number.isSafeInteger(values[0])) return fail();
  return values[0] / (current.length ? 1 : 100);
}
async function execute(context: Context): Promise<FeedAccount[]> {
  let key = await apiKey(context, ID, ["CODEXBAR_HUGGINGFACE_API_KEY", "HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"]);
  if (!key) {
    const expand = (path: string) => path.replace(/^~(?=\/|$)/, context.home);
    const path = context.env.HF_TOKEN_PATH ? expand(context.env.HF_TOKEN_PATH) : context.env.HF_HOME ? join(expand(context.env.HF_HOME), "token") :
      join(expand(context.env.XDG_CACHE_HOME || join(context.home, ".cache")), "huggingface", "token");
    key = (await context.readFile(path))?.split(/\r?\n/).find(line => line.trim())?.trim().replace(/^(["'])(.*)\1$/, "$2").trim() || null;
  }
  key = key?.replace(/^(["'])(.*)\1$/, "$2").trim() || null;
  if (!key) throw new NotConfigured(NAME);
  const now = new Date(context.now() * 1000), start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000;
  const headers = { "User-Agent": "CodexBar" };
  const data = await read(context, `https://huggingface.co/api/settings/billing/usage-v2?startDate=${start}&endDate=${context.now()}`, key, headers);
  const inference = object(object(data.usage).inferenceProviders);
  const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fail();
  const billable = Math.max(0, nonnegative(inference.usedNanoUsd) - nonnegative(inference.includedNanoUsd)) / 1e9;
  if (inference.limitNanoUsd != null) nonnegative(inference.limitNanoUsd);
  if (inference.numRequests != null && !Number.isSafeInteger(nonnegative(inference.numRequests))) return fail();
  let gpu: FeedWindow | null = null;
  try {
    const data = await read(context, "https://huggingface.co/api/spaces/zero-gpu/quota", key, headers);
    const total = nonnegative(data.base), remaining = nonnegative(data.current);
    const reset = typeof data.resetsAt === "number" ? data.resetsAt > 0 && data.resetsAt <= 64092211200 ? data.resetsAt : null : isoToSeconds(data.resetsAt);
    if (total > 0) gpu = feedWindow(null, Math.max(0, total - remaining) / total * 100, reset, context.now(), "ZeroGPU");
  } catch { /* Optional quota must not hide billing. */ }
  const cached = identities.get(context);
  let identity: Record<string, unknown> = {};
  if (cached && cached.token === key && context.now() >= cached.fetchedAt && context.now() - cached.fetchedAt < 43200) {
    identity = cached.profile;
  } else {
    identities.delete(context);
    try {
      identity = await read(context, "https://huggingface.co/api/whoami-v2", key, headers);
      if (typeof identity.name === "string" || typeof identity.email === "string" || typeof identity.id === "string")
        identities.set(context, { token: key, fetchedAt: context.now(), profile: identity });
    } catch { /* Optional identity. */ }
  }
  let balance: number | null = null;
  if (identity.type === "user" && typeof identity.id === "string" && identity.id.trim()) {
    try {
      const cookie = await cookieHeader(context, ID, { domains: ["huggingface.co"] });
      if (cookie) {
        const web = async (path: string, accept: string) => {
          const response = await context.fetch(`https://huggingface.co${path}`, { headers: { Cookie: cookie, Accept: accept }, redirect: "error", signal: AbortSignal.timeout(30_000) });
          if (!response.ok) return fail();
          return response;
        };
        const page = await web("/settings/billing", "text/html");
        if (!page.headers.get("content-type")?.toLowerCase().includes("text/html")) return fail();
        const candidate = walletBalance(await page.text());
        const profile = object(await (await web("/api/whoami-v2", "application/json")).json());
        if (profile.type === "user" && profile.id === identity.id) balance = candidate;
      }
    } catch { /* Unverified or unavailable browser wallets are omitted. */ }
  }
  const windows: FeedWindow[] = gpu ? [gpu] : [];
  windows.push(valueWindow("spent", usd(billable)));
  if (balance !== null && windows.length < 2) windows.push(valueWindow("balance", usd(balance)));
  return account(context, windows, identity.email);
}
export const huggingface: Provider = {
  id: ID, name: NAME, async fetch(context) {
    try { return await execute(context); } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403))
        return account(context, []).map(a => ({ ...a, error: "sign in" }));
      throw error;
    }
  }
};
