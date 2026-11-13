import { accountLabel, finiteNumber, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { jwtPayload } from "./codex.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, isProviderHost, type Context, type Provider } from "./types.ts";

class SignIn extends Error {}
const compact = (n: number) => n >= 1e12 ? n.toExponential(1) : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(0);
function endpoint(raw: string | undefined, fallback: string, host: string): URL {
  let url: URL;
  try { const value = raw?.trim() || fallback; url = new URL(value.includes("://") ? value : `https://${value}`); }
  catch { throw new NotConfigured("Groq"); }
  if (!isProviderHost(url, [host]) || url.username || url.password) throw new NotConfigured("Groq");
  return url;
}
async function request(context: Context, url: URL, init: RequestInit): Promise<unknown> {
  const response = await context.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  if (response.status === 401 || response.status === 403) throw new SignIn();
  if (response.status === 429) throw new RateLimited("Groq", context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError("Groq", response.status);
  try { return await response.json(); } catch { throw new HttpError("Groq", response.status); }
}
export function parseScalar(body: unknown): number {
  if (!isRecord(body) || body.status !== "success" || !isRecord(body.data) || !Array.isArray(body.data.result)) throw new HttpError("Groq", 200);
  let total = 0;
  for (const row of body.data.result) {
    const sample = isRecord(row) && Array.isArray(row.value) ? row.value : [];
    const value = finiteNumber(sample[1]);
    if (sample.length !== 2 || finiteNumber(sample[0]) === null || value === null || value < 0 || !Number.isFinite(total + value)) throw new HttpError("Groq", 200);
    total += value;
  }
  return total;
}
function cookieValue(header: string | null, name: string): string | null {
  return header?.split(";").map((pair) => pair.trim()).find((pair) => pair.startsWith(name + "="))?.slice(name.length + 1) || null;
}
async function consoleUsage(context: Context, baseURL: URL, header: string): Promise<{ windows: FeedAccount["windows"]; email: string | null }> {
  let token = cookieValue(header, "stytch_session_jwt");
  const session = cookieValue(header, "stytch_session");
  if (session) {
    const stytch = endpoint(context.env.GROQ_STYTCH_URL, "https://api.stytchb2b.groq.com", "api.stytchb2b.groq.com");
    stytch.pathname = stytch.pathname.replace(/\/$/, "") + "/sdk/v1/b2b/sessions/authenticate";
    const publicToken = context.env.GROQ_STYTCH_PUBLIC_TOKEN?.trim() || "public-token-live-58df57a9-a1f5-4066-bc0c-2ff942db684f";
    try {
      // Stytch authenticates the same opaque session; only the returned JWT stays in memory.
      const body = await request(context, stytch, {
        method: "POST", headers: {
          Authorization: "Basic " + Buffer.from(`${publicToken}:${session}`).toString("base64"),
          "Content-Type": "application/json", Origin: "https://console.groq.com", "X-SDK-Parent-Host": "https://console.groq.com",
          "X-SDK-Client": Buffer.from(JSON.stringify({ app: { identifier: "console.groq.com" }, sdk: { identifier: "Stytch.js Javascript SDK", version: "5.43.0" } })).toString("base64"),
        }, body: JSON.stringify({ session_token: session, session_duration_minutes: 30 }),
      });
      const fresh = isRecord(body) && isRecord(body.data) ? body.data.session_jwt : null;
      if (typeof fresh !== "string" || !fresh.trim()) throw new HttpError("Groq", 200);
      token = fresh.trim();
    } catch (error) { if (!token || error instanceof RateLimited) throw error; }
  }
  if (!token) throw new NotConfigured("Groq");
  const payload = jwtPayload(token);
  const claim = payload?.["https://groq.com/organization"];
  const fallbackClaim = payload?.["https://stytch.com/organization"];
  const org = isRecord(claim) && typeof claim.id === "string" && claim.id ? claim.id
    : isRecord(fallbackClaim) && typeof fallbackClaim.slug === "string" && fallbackClaim.slug ? fallbackClaim.slug : null;
  if (!org) throw new SignIn();
  const today = new Date(context.now() * 1000); today.setHours(0, 0, 0, 0);
  const end = new Date(today); end.setDate(end.getDate() + 1);
  const start = new Date(today); start.setDate(start.getDate() - 29);
  baseURL.pathname = `/platform/v1/organizations/${encodeURIComponent(org)}/activity`;
  baseURL.search = new URLSearchParams({ start_date: String(start.getTime() / 1000), end_date: String(end.getTime() / 1000) }).toString();
  const body = await request(context, baseURL, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!isRecord(body) || !Array.isArray(body.data)) throw new HttpError("Groq", 200);
  let cost = 0; let tokens = 0;
  for (const row of body.data) {
    if (!isRecord(row) || finiteNumber(row.timestamp) === null) throw new HttpError("Groq", 200);
    const amount = row.cost == null ? 0 : finiteNumber(row.cost);
    const input = row.n_context_tokens_total == null ? 0 : finiteNumber(row.n_context_tokens_total);
    const output = row.n_generated_tokens_total == null ? 0 : finiteNumber(row.n_generated_tokens_total);
    if (amount === null || input === null || output === null || amount < 0 || input < 0 || output < 0) throw new HttpError("Groq", 200);
    cost += amount; tokens += input + output;
  }
  if (!Number.isFinite(cost) || !Number.isFinite(tokens)) throw new HttpError("Groq", 200);
  const dollars = `$${cost.toFixed(2)}`;
  return { windows: [valueWindow("30d", dollars.length <= 12 ? dollars : `$${compact(cost)}`), valueWindow("Tokens", `${compact(tokens)} tok`)], email: typeof payload?.email === "string" ? payload.email : null };
}
export const groq: Provider = {
  id: "groq", name: "Groq",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base = { provider: "groq", account: accountLabel(null), blocked: false, observed_at: new Date(now * 1000).toISOString(), windows: [] };
    const entry = await providerEntry(context, "groq");
    const baseURL = endpoint(context.env.GROQ_API_URL, "https://api.groq.com/v1", "api.groq.com");
    try {
      if (entry.source !== "api") {
        const envCookie = [context.env.GROQ_SESSION_TOKEN?.trim() ? `stytch_session=${context.env.GROQ_SESSION_TOKEN.trim()}` : "", context.env.GROQ_SESSION_JWT?.trim() ? `stytch_session_jwt=${context.env.GROQ_SESSION_JWT.trim()}` : ""].filter(Boolean).join("; ");
        const header = await cookieHeader(envCookie ? { ...context, env: { ...context.env, GROQ_SESSION_COOKIE: envCookie } } : context, "groq", {
          domains: ["groq.com", "console.groq.com"], envNames: ["GROQ_SESSION_COOKIE"], required: ["stytch_session", "stytch_session_jwt"],
        });
        if (header) {
          try {
            const result = await consoleUsage(context, new URL(baseURL), header);
            return [{ ...base, account: accountLabel(result.email), windows: result.windows }];
          } catch (error) {
            if (!(error instanceof SignIn) || entry.source === "web" || !(await apiKey(context, "groq", ["GROQ_API_KEY"]))) throw error;
          }
        }
        if (entry.source === "web") throw new NotConfigured("Groq");
      }
      const key = await apiKey(context, "groq", ["GROQ_API_KEY"]);
      if (!key) throw new NotConfigured("Groq");
      const queries = ["sum(model_project_id_status_code:requests:rate5m)", "sum(model_project_id:tokens_in:rate5m)", "sum(model_project_id:tokens_out:rate5m)", "sum(model_project_id:prompt_cache_hits:rate5m)"];
      const rates = await Promise.all(queries.map(async (query) => {
        const url = new URL(baseURL); url.pathname = url.pathname.replace(/\/$/, "") + "/metrics/prometheus/api/v1/query"; url.search = new URLSearchParams({ query }).toString();
        return parseScalar(await request(context, url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } }));
      }));
      const [requests = 0, input = 0, output = 0, cache = 0] = rates;
      if (![requests * 60, (input + output) * 60, cache * 60].every(Number.isFinite)) throw new HttpError("Groq", 200);
      return [{ ...base, windows: [valueWindow("Req/min", compact(requests * 60)), valueWindow("Tok/min", compact((input + output) * 60))] }];
    } catch (error) { if (error instanceof SignIn) return [{ ...base, error: "sign in" }]; throw error; }
  },
};
