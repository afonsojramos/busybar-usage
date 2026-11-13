import { cookieHeader } from "../cookies.ts";
import { accountLabel, feedWindow, isRecord, isoToSeconds } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError("Qoder", 200);
  return value;
}
function field(value: Record<string, unknown>, camel: string, snake: string): unknown {
  return value[camel] ?? value[snake];
}
function quota(value: unknown) {
  if (!isRecord(value)) throw new HttpError("Qoder", 200);
  const summary = field(value, "quotaSummary", "quota_summary");
  if (!isRecord(summary)) throw new HttpError("Qoder", 200);
  const used = number(field(summary, "usedValue", "used_value"));
  const total = number(field(summary, "limitValue", "limit_value"));
  const left = field(summary, "remainingValue", "remaining_value");
  const remaining = left == null ? Math.max(0, total - used) : number(left);
  const provided = field(summary, "usagePercentage", "usage_percentage");
  const percent = provided == null ? null : number(provided);
  if (used < 0 || total < 0 || remaining < 0 || (summary.unit != null && typeof summary.unit !== "string")) {
    throw new HttpError("Qoder", 200);
  }
  return { used, total, remaining, percent };
}

function invalidCapture(): never { throw new NotConfigured("Qoder"); }
function site(host: string): string {
  const normalized = host.trim().replace(/^["']|["']$/g, "").toLowerCase().replace(/^\./, "");
  const match = /^(?:www\.)?(qoder\.com(?:\.cn)?)(?::([0-9]+))?$/.exec(normalized);
  if (!match?.[1] || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) invalidCapture();
  return match[1];
}
function urlSite(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") invalidCapture();
    return site(url.host);
  } catch { return invalidCapture(); }
}
function unquote(value: string): string {
  const text = value.trim();
  return /^("[\s\S]*"|'[\s\S]*')$/.test(text) ? text.slice(1, -1) : text;
}
function curlTokens(raw: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index];
    if (char === undefined) continue;
    const next = raw[index + 1];
    if (char === "\\" && quote !== "'") {
      if (quote === null && (next === "\n" || (next === "\r" && raw[index + 2] === "\n"))) {
        index += next === "\r" ? 2 : 1;
        continue;
      }
      if (next && /['"\\]/.test(next)) { token += next; index++; continue; }
      if (quote === '"') invalidCapture();
    }
    if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) {
      if (quote === null && /\s/.test(char)) {
        if (token) tokens.push(token);
        token = "";
        continue;
      }
      invalidCapture();
    }
    if (quote !== "'" && (char === "`" || (char === "$" && next && /['"({[\w*@#?$!\-]/.test(next)))) {
      invalidCapture();
    }
    if (quote !== null) {
      if (char === quote) quote = null; else token += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (/[;|&<>]/.test(char)) invalidCapture();
    else if (/\s/.test(char)) { if (token) tokens.push(token); token = ""; }
    else token += char;
  }
  if (quote !== null) invalidCapture();
  if (token) tokens.push(token);
  return tokens;
}

function manualSession(raw: string): { header: string; domain: string } {
  const curl = /(?:^|[\s;])(?:[^\s;=]+\/)?curl(?:$|[\s;])/i.test(raw);
  const headers: string[] = [];
  const cookies: string[] = [];
  const routes: string[] = [];
  if (curl) {
    const tokens = curlTokens(raw);
    let command = 0;
    while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(tokens[command] ?? "")) command++;
    if (!/(?:^|\/)curl$/i.test(tokens[command] ?? "")) invalidCapture();
    const targets = new Map<number, string>();
    const explicit = new Set<number>();
    for (let index = command + 1; index < tokens.length; index++) {
      const token = tokens[index] ?? "";
      const lower = token.toLowerCase();
      if (lower === "--config" || lower.startsWith("--config=") || lower.startsWith("--expand-") ||
          lower === "--location-trusted" || (/^-[^-]/.test(token) && token.slice(1).includes("K"))) invalidCapture();
      if (lower === "--url") {
        index++;
        targets.set(index, urlSite(tokens[index] ?? ""));
        explicit.add(index);
      } else if (lower.startsWith("--url=")) {
        targets.set(index, urlSite(token.slice(6)));
        explicit.add(index);
      } else if (/^https?:\/\//i.test(token)) targets.set(index, urlSite(token));
      else if (lower === "--header" || lower === "-h") {
        index++;
        const value = tokens[index];
        if (!value) invalidCapture();
        headers.push(value);
      } else if (lower.startsWith("--header=")) headers.push(token.slice(9));
      else if (/^-[fsSL]*H/.test(token)) {
        let value = token.replace(/^-[fsSL]*H/, "");
        if (!value) { index++; value = tokens[index] ?? ""; }
        if (!value) invalidCapture();
        headers.push(value);
      } else if (lower === "--cookie" || lower === "-b") {
        index++;
        const value = tokens[index];
        if (!value) invalidCapture();
        cookies.push(value);
      } else if (/^-b.+/.test(token)) cookies.push(token.slice(2));
    }
    if (targets.size !== 1) invalidCapture();
    const target = targets.entries().next().value;
    if (!target || (target[0] !== command + 1 && !explicit.has(target[0]))) invalidCapture();
    routes.push(target[1]);
  } else {
    let requests = 0;
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z]+)\s+(\S+)(?:\s+HTTP\/\S+)?\s*$/.exec(line);
      if (match && (/^(get|post|put|patch|delete|head|options|trace|connect)$/i.test(match[1] ?? "") || /HTTP\//i.test(line))) {
        if (!/^(get|post|put|patch|delete|head|options)$/i.test(match[1] ?? "") || ++requests > 1) invalidCapture();
        const target = match[2] ?? "";
        if (!target.startsWith("/")) routes.push(urlSite(target));
      } else if (/^\s*(?:Cookie|Host):/i.test(line)) headers.push(line.trim());
    }
    if (requests === 0) {
      const header = unquote(raw.replace(/^Cookie:\s*/i, ""));
      if (!header || /[\r\n]/.test(header)) invalidCapture();
      for (const pair of raw.split(";")) {
        const domain = /^\s*domain\s*=([\s\S]*)$/i.exec(pair)?.[1];
        if (domain !== undefined) routes.push(site(unquote(domain)));
      }
      if (routes.some((route) => route !== routes[0])) invalidCapture();
      return { header, domain: routes[0] ?? "qoder.com" };
    }
  }
  for (const rawHeader of headers) {
    const header = rawHeader.trim();
    if (header.startsWith("@")) invalidCapture();
    const host = /^Host:\s*(.*)$/i.exec(header)?.[1];
    if (host !== undefined) routes.push(site(host));
    else if (/^host(?:\s|;|$)/i.test(header)) invalidCapture();
    const cookie = /^Cookie:\s*(.*)$/i.exec(header)?.[1];
    if (cookie !== undefined) cookies.push(unquote(cookie));
  }
  if (!routes.length || routes.some((route) => route !== routes[0]) || cookies.length !== 1 || !cookies[0] ||
      /[\r\n]/.test(cookies[0])) invalidCapture();
  return { header: cookies[0], domain: routes[0] ?? "qoder.com" };
}

export const qoder: Provider = {
  id: "qoder", name: "Qoder",
  async fetch(context) {
    const entry = await providerEntry(context, "qoder");
    if (entry.cookieSource === "off") throw new NotConfigured("Qoder");
    const saved = typeof entry.cookieHeader === "string" && entry.cookieHeader.trim() !== "";
    let rejected = false;
    for (const domain of ["qoder.com", "qoder.com.cn"]) {
      const raw = await cookieHeader(context, "qoder", { domains: [domain] });
      if (!raw) continue;
      const session = saved ? manualSession(raw) : { header: raw, domain };
      const origin = `https://${session.domain}`;
      const now = context.now();
      const base = { provider: "qoder", account: accountLabel(null), blocked: false,
        observed_at: new Date(now * 1000).toISOString(), windows: [] };
      const response = await context.fetch(`${origin}/api/v2/me/usages/big_model_credits`, {
        headers: { Cookie: session.header, Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9", Origin: origin, Referer: `${origin}/account/usage`,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
          "X-Requested-With": "XMLHttpRequest", "Bx-V": "2.5.35" },
        signal: AbortSignal.timeout(30_000), redirect: "manual",
      });
      if (response.status === 401 || response.status === 403) {
        if (saved) return [{ ...base, error: "sign in" }];
        rejected = true;
        continue;
      }
      if (response.status === 429) throw new RateLimited("Qoder", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Qoder", response.status);
      let root: unknown;
      try { root = await response.json(); } catch { throw new HttpError("Qoder", response.status); }
      if (!isRecord(root)) throw new HttpError("Qoder", response.status);
      const first = quota(field(root, "totalQuota", "total_quota"));
      const sharedValue = field(root, "sharedQuota", "shared_quota");
      if (sharedValue != null && !isRecord(sharedValue)) throw new HttpError("Qoder", 200);
      const sharedSummary = isRecord(sharedValue) ? field(sharedValue, "quotaSummary", "quota_summary") : null;
      const shared = sharedSummary == null ? null : quota(sharedValue);
      const used = number(first.used + (shared?.used ?? 0));
      const total = number(first.total + (shared?.total ?? 0));
      const remaining = number(first.remaining + (shared?.remaining ?? 0));
      if (total === 0 && (used !== 0 || remaining !== 0)) throw new HttpError("Qoder", 200);
      const percent = number((shared ? null : first.percent) ?? (total > 0 ? used / total * 100 : 100));
      const reset = field(root, "nextResetAt", "next_reset_at");
      const resetsAt = typeof reset === "number" && Number.isFinite(reset)
        ? reset / (reset > 10_000_000_000 ? 1000 : 1) : isoToSeconds(reset);
      const windows = [feedWindow(null, Math.max(0, Math.min(100, percent)), resetsAt, now, "credit")];
      return [{ ...base, blocked: windows.some((window) => (window.used_percent ?? 0) >= 100), windows }];
    }
    if (rejected) return [{ provider: "qoder", account: accountLabel(null), blocked: false,
      observed_at: new Date(context.now() * 1000).toISOString(), windows: [], error: "sign in" }];
    throw new NotConfigured("Qoder");
  },
};
