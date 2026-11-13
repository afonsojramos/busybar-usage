import { cookieHeader } from "../cookies.ts";
import { accountLabel, feedWindow, finiteNumber, isRecord, isoToSeconds, valueWindow, type FeedWindow } from "../feed.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const VIBE_URL = "https://console.mistral.ai/api-ui/trpc/billing.vibeUsage?batch=1&input=%7B%220%22%3A%7B%22json%22%3Anull%2C%22meta%22%3A%7B%22values%22%3A%5B%22undefined%22%5D%2C%22v%22%3A1%7D%7D%7D";

function money(amount: number, currency: unknown): string {
  const prefix = currency === "EUR" ? "€" : currency === "USD" ? "$" : "¤";
  const fixed = `${prefix}${amount.toFixed(2)}`;
  return fixed.length <= 12 ? fixed : `${prefix}${amount.toExponential(2)}`;
}
function priceKey(row: Record<string, unknown>, unqualified = false): string {
  return JSON.stringify([row.event_type ?? null, row.billing_metric, row.billing_group,
    unqualified ? null : row.api_zone ?? null, unqualified ? null : row.service_tier ?? null]);
}
function spend(root: unknown): { amount: number; currency: string } {
  if (!isRecord(root)) throw new HttpError("Mistral", 200);
  const prices = new Map<string, number>();
  if (root.prices != null && !Array.isArray(root.prices)) throw new HttpError("Mistral", 200);
  for (const row of Array.isArray(root.prices) ? root.prices : []) {
    if (!isRecord(row)) throw new HttpError("Mistral", 200);
    const price = finiteNumber(row.price);
    if (price !== null && typeof row.billing_metric === "string" && typeof row.billing_group === "string") {
      prices.set(priceKey(row), price);
    }
  }
  let amount = 0;
  const modelGroups: unknown[] = [];
  for (const name of ["completion", "chat", "ocr", "connectors", "audio"]) {
    const category = root[name];
    if (category != null && !isRecord(category)) throw new HttpError("Mistral", 200);
    if (isRecord(category)) modelGroups.push(category.models);
  }
  const vibe = isRecord(root.vibe_code) && isRecord(root.vibe_code.completion) ? root.vibe_code.completion.models : null;
  const libraries = isRecord(root.libraries_api) ? root.libraries_api : {};
  const tuning = isRecord(root.fine_tuning) ? root.fine_tuning : {};
  modelGroups.push(vibe, isRecord(libraries.pages) ? libraries.pages.models : null,
    isRecord(libraries.tokens) ? libraries.tokens.models : null, tuning.training, tuning.storage);
  for (const models of modelGroups) {
    if (models == null) continue;
    if (!isRecord(models)) throw new HttpError("Mistral", 200);
    for (const model of Object.values(models)) {
      if (!isRecord(model)) throw new HttpError("Mistral", 200);
      for (const lane of ["input", "output", "cached"]) {
        const entries = model[lane];
        if (entries == null) continue;
        if (!Array.isArray(entries)) throw new HttpError("Mistral", 200);
        for (const entry of entries) {
          if (!isRecord(entry)) throw new HttpError("Mistral", 200);
          const units = entry.value_paid ?? entry.value ?? 0;
          if (typeof units !== "number" || !Number.isSafeInteger(units)) throw new HttpError("Mistral", 200);
          const cost = units * (prices.get(priceKey(entry)) ?? prices.get(priceKey(entry, true)) ?? 0);
          if (Number.isFinite(cost) && Number.isFinite(amount + cost)) amount += cost;
        }
      }
    }
  }
  return { amount, currency: typeof root.currency === "string" ? root.currency.trim().toUpperCase() : "XXX" };
}

function budgets(html: string, now: number): { api: FeedWindow | null; vibe: FeedWindow | null } {
  const chunks: string[] = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\s*(\[1\s*,\s*"(?:[^"\\]|\\.)*"\s*\])/g)) {
    const parsed: unknown = JSON.parse(match[1] ?? "null");
    if (Array.isArray(parsed) && typeof parsed[1] === "string") chunks.push(parsed[1]);
  }
  const buffer = Buffer.from(chunks.join(""));
  const found = new Map<string, { api: FeedWindow | null; vibe: FeedWindow | null }>();
  const lane = (value: unknown): FeedWindow | null => {
    if (!isRecord(value)) return null;
    const used = finiteNumber(value.usage_percentage);
    const limit = finiteNumber(value.initial_budget);
    if (used === null || used < 0 || limit === null || limit <= 0 || !Number.isFinite(limit * used / 100) ||
        typeof value.currency !== "string" || value.currency.trim() === "") return null;
    return feedWindow(43200, used, isoToSeconds(value.reset_at), now, "30d");
  };
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) collect(child); return; }
    if (!isRecord(value)) return;
    if (isRecord(value.budget)) {
      const api = lane(value.budget.api_budget);
      const vibe = lane(value.budget.vibe_budget);
      if (api || vibe) {
        const candidate = { api, vibe };
        found.set(JSON.stringify(value.budget), candidate);
      }
    }
    for (const child of Object.values(value)) collect(child);
  };
  let cursor = 0;
  while (cursor < buffer.length) {
    let end = buffer.indexOf(10, cursor);
    if (end < 0) end = buffer.length;
    const line = buffer.subarray(cursor, end).toString("utf8");
    const row = /^([\da-f]+):([\s\S]*)$/i.exec(line);
    cursor = end + 1;
    if (!row?.[2]) continue;
    const body = row[2];
    if (/^[TAOoUSsLlGgMmV]/.test(body)) {
      const length = /^[TAOoUSsLlGgMmV]([\da-f]+),/i.exec(body);
      if (!length) throw new HttpError("Mistral", 200);
      const bytes = Number.parseInt(length[1] ?? "", 16);
      const prefixLength = Buffer.byteLength(`${row[1]}:${length[0]}`);
      const start = end - Buffer.byteLength(line) + prefixLength;
      if (!Number.isSafeInteger(bytes) || start + bytes > buffer.length) throw new HttpError("Mistral", 200);
      cursor = start + bytes;
    } else if (/^[\[{]/.test(body)) collect(JSON.parse(body));
  }
  if (found.size !== 1) return { api: null, vibe: null };
  return found.values().next().value ?? { api: null, vibe: null };
}

export const mistral: Provider = {
  id: "mistral", name: "Mistral",
  async fetch(context) {
    const raw = await cookieHeader(context, "mistral", {
      domains: ["mistral.ai", "admin.mistral.ai", "auth.mistral.ai", "console.mistral.ai"],
    });
    if (!raw) throw new NotConfigured("Mistral");
    const cookie = raw.replace(/^Cookie:\s*/i, "").trim();
    if (!/(?:^|;\s*)ory_session_[^=;]+=/.test(cookie)) throw new NotConfigured("Mistral");
    const csrf = /(?:^|;\s*)csrftoken=([^;]+)/.exec(cookie)?.[1]?.trim();
    const now = context.now();
    const base = { provider: "mistral", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [] };
    const headers: Record<string, string> = { Cookie: cookie, Accept: "*/*", Origin: "https://admin.mistral.ai",
      Referer: "https://admin.mistral.ai/organization/usage" };
    if (csrf) headers["X-CSRFTOKEN"] = csrf;
    const get = (url: string, extra: Record<string, string> = {}) => context.fetch(url, {
      headers: { ...headers, ...extra }, signal: AbortSignal.timeout(30_000), redirect: "manual",
    });
    const date = new Date(now * 1000);
    const response = await get(`https://admin.mistral.ai/api/billing/v2/usage?month=${date.getUTCMonth() + 1}&year=${date.getUTCFullYear()}`);
    const login = response.status >= 300 && response.status < 400 &&
      /^https:\/\/auth\.mistral\.ai\/self-service\/login(?:\/|\?|$)/.test(response.headers.get("location") ?? "");
    if (response.status === 401 || response.status === 403 || login) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Mistral", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Mistral", response.status);
    let usage;
    try { usage = spend(await response.json()); } catch { throw new HttpError("Mistral", response.status); }
    let allowances: ReturnType<typeof budgets> = { api: null, vibe: null };
    try {
      const page = await get("https://admin.mistral.ai/subscription", { Accept: "text/html",
        "Accept-Language": "en-US,en;q=0.9", Referer: "https://admin.mistral.ai/subscription" });
      if (page.ok) allowances = budgets(await page.text(), now);
    } catch { /* Optional subscription data must not hide billing usage. */ }
    if (!allowances.vibe && csrf && !/[;,\r\n]/.test(csrf)) {
      const sessions = cookie.split(";").map((pair) => pair.trim()).filter((pair) => pair.startsWith("ory_session_"));
      try {
        const vibeResponse = await context.fetch(VIBE_URL, { headers: { Accept: "*/*",
          Cookie: [`csrftoken=${csrf}`, ...sessions].join("; "), "X-CSRFToken": csrf },
          signal: AbortSignal.timeout(30_000), redirect: "manual" });
        if (vibeResponse.ok) {
          const data: unknown = await vibeResponse.json();
          const first = Array.isArray(data) ? data[0] : null;
          const result = isRecord(first) && isRecord(first.result) ? first.result.data : null;
          const value = isRecord(result) ? result.json : null;
          const used = isRecord(value) ? finiteNumber(value.usage_percentage) : null;
          if (isRecord(value) && used !== null && used >= 0 && used <= 100) {
            allowances.vibe = feedWindow(43200, used, isoToSeconds(value.reset_at), now, "30d");
          }
        }
      } catch { /* The console allowance is best-effort. */ }
    }
    let balance: FeedWindow | null = null;
    try {
      const creditsResponse = await get("https://admin.mistral.ai/api/billing/credits", {
        Referer: "https://admin.mistral.ai/organization/billing" });
      if (creditsResponse.ok) {
        const credits: unknown = await creditsResponse.json();
        if (isRecord(credits)) {
          const wallet = finiteNumber(credits.wallet_amount);
          const notes = finiteNumber(credits.credit_notes_amount ?? 0);
          const ongoing = finiteNumber(credits.ongoing_usage_balance ?? 0);
          if (wallet !== null && notes !== null && ongoing !== null && Number.isFinite(wallet + notes - ongoing)) {
            balance = valueWindow("balance", money(Math.max(0, wallet + notes - ongoing), credits.currency));
          }
        }
      }
    } catch { /* Credits are optional. */ }
    const windows = [allowances.api, allowances.vibe].filter((lane): lane is FeedWindow => lane !== null);
    if (windows.length === 0) windows.push(valueWindow("spend", money(usage.amount, usage.currency)));
    if (windows.length < 2 && balance) windows.push(balance);
    return [{ ...base, blocked: windows.some((lane) => (lane.used_percent ?? 0) >= 100), windows }];
  },
};
