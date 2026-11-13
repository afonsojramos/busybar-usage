import { accountLabel, feedWindow, valueWindow, finiteNumber, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider, type Context } from "./types.ts";

class SignIn extends Error { }

async function localHistory(context: Context): Promise<FeedWindow | null> {
  const root = context.env.MUSE_SESSIONS_DIR ||
    `${context.env.XDG_DATA_HOME || `${context.home}/.local/share`}/muse/sessions`;
  const today = new Date(context.now() * 1000).toDateString();
  let total = 0, files = 0, bytes = 0, entries = 0, measured = false;
  const seen = new Set<string>();
  const deadline = Date.now() + 1000;
  async function walk(dir: string, depth: number): Promise<boolean> {
    const names = await context.listDir(dir);
    if (!names) return true;
    for (const name of names) {
      if (++entries > 4096 || Date.now() > deadline) return false;
      if (!name || name === "." || name === ".." || /[\\/]/.test(name)) continue;
      if (depth < 4) {
        if (depth < 3 && !/^\d+$/.test(name)) continue;
        if (!await walk(`${dir}/${name}`, depth + 1)) return false;
      } else if (name === "session.jsonl") {
        if (++files > 256) return false;
        const text = await context.readFile(`${dir}/${name}`);
        if (text === null) return false;
        bytes += Buffer.byteLength(text);
        if (bytes > 8 * 1024 * 1024) return false;
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          if (line.length > 1024 * 1024) return false;
          let record: unknown;
          try { record = JSON.parse(line); } catch { return false; }
          if (!isRecord(record) || record.schema_version !== 1 || record.record_type !== "event" ||
            record.payload_type !== "runtime.session" || record.payload_schema_version !== 1) return false;
          const event = isRecord(record.payload) && isRecord(record.payload.event) ? record.payload.event : null;
          if (!event) return false;
          if (event.kind !== "model_completed" && event.kind !== "automated_review_completed") {
            if (!["resource_usage_sampled", "workflow_child_lifecycle", "goal_usage_attribution"].includes(String(event.kind)) &&
              /"(?:input_tokens|output_tokens|total_tokens|cached_tokens|reasoning_tokens)"/.test(line)) return false;
            continue;
          }
          const usage = event.usage;
          if (!isRecord(usage) || typeof record.id !== "string" || !record.id ||
            typeof record.recorded_at !== "number" || !Number.isSafeInteger(record.recorded_at)) return false;
          const input = usage.input_tokens, output = usage.output_tokens;
          if (typeof input !== "number" || typeof output !== "number" ||
            !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) return false;
          const tokens = input + output;
          if (!Number.isSafeInteger(tokens) || usage.total_tokens != null && usage.total_tokens !== tokens) return false;
          for (const key of ["cached_input_tokens", "cached_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"]) {
            const counter = usage[key];
            if (counter != null && (typeof counter !== "number" || !Number.isSafeInteger(counter) ||
              counter < 0 || counter > (key === "reasoning_tokens" ? output : input))) return false;
          }
          if (new Date(record.recorded_at / 1000).toDateString() !== today || seen.has(record.id)) continue;
          seen.add(record.id);
          measured = true;
          total += tokens;
          if (!Number.isSafeInteger(total)) return false;
        }
      }
    }
    return true;
  }
  // Omit incomplete scans rather than presenting a partial local total as a full day.
  if (!await walk(root, 0) || !measured) return null;
  const amount = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(total);
  return valueWindow("local", `${amount} tok`);
}

export const muse: Provider = {
  id: "muse",
  name: "Muse Code",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: "muse", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: []
    };
    const invalid = (): never => { throw new HttpError("Muse Code", 200); };
    const object = (v: unknown): Record<string, unknown> => isRecord(v) ? v : invalid();
    const number = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : invalid();
    const decode = (text: string): unknown => { try { return JSON.parse(text); } catch { return invalid(); } };
    const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const response = await context.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited("Muse Code", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Muse Code", response.status);
      return response;
    };
    try {
      const path = context.env.MUSE_AUTH_PATH || `${context.home}/.config/muse/auth.json`;
      const file = await context.readFile(path);
      let token: string | null = null;
      if (file) {
        let auth: unknown;
        try { auth = JSON.parse(file); } catch { auth = null; }
        const providers = isRecord(auth) && isRecord(auth.providers) ? auth.providers : null;
        const meta = providers && isRecord(providers.meta) ? providers.meta : null;
        if (typeof meta?.access_token === "string" && meta.access_token.trim()) token = meta.access_token.trim();
      }
      if (!token && context.platform === "darwin") {
        const item = await context.readKeychain("ai.meta.dev.credentials", "meta");
        if (item) {
          const payload = object(decode(item));
          if (typeof payload.access_token === "string") token = payload.access_token.trim();
        }
      }
      if (!token) throw new NotConfigured("Muse Code");
      if (!token.startsWith("dca:")) throw new SignIn();
      const response = await request("https://api.meta.ai/muse-code/key", {
        method: "POST", body: "{}",
        headers: { Authorization: `Bearer ${token}`, "x-api-version": "1.0.0", "User-Agent": "CodexBar", "Content-Type": "application/json" }
      });
      const root = object(decode(await response.text()));
      for (const key of ["require_payment", "is_subs_active"]) {
        if (root[key] != null && typeof root[key] !== "boolean") invalid();
      }
      base.account = accountLabel(typeof root.user_email === "string" ? root.user_email : null);
      if (root.require_payment === true) return [{ ...base, error: "billing" }];
      if (root.is_subs_active !== true) return [{ ...base, error: "no plan" }];
      const reset = (v: unknown): number | null => {
        if (v == null) return null;
        const n = number(v); return n > 0 && n <= 64092211200 ? n : null;
      };
      if (root.subs_usage != null) {
        const usage = object(root.subs_usage), window = object(usage.window), weekly = object(usage.weekly);
        const minutes = Math.round(number(window.window_duration_mins));
        if (!Number.isSafeInteger(minutes) || minutes <= 0) invalid();
        base.windows = [feedWindow(minutes, Math.min(100, Math.max(0, number(window.used_percent))), reset(window.resets_at), now),
        feedWindow(10080, Math.min(100, Math.max(0, number(weekly.used_percent))), reset(weekly.resets_at), now)];
      } else {
        const entry = await providerEntry(context, "muse");
        const selected = typeof entry.workspaceID === "string" ? entry.workspaceID.trim() : "";
        const email = typeof root.user_email === "string" ? root.user_email.trim().toLowerCase() : "";
        if (entry.cookieSource !== "off" && entry.cookieSource != null && selected && email && /^[0-9]+$/.test(selected)) {
          // Browser team quotas are optional and must match the CLI account and selected plan.
          try {
            const cookie = await cookieHeader(context, "muse", { domains: ["dev.meta.ai"], required: ["llama_dev_sess"] });
            if (cookie) {
              const get = async (p: string) => object(decode(await (await request(`https://dev.meta.ai${p}`, {
                headers: { Cookie: cookie, "User-Agent": "CodexBar" }
              })).text()));
              const me = await get("/api/auth/me");
              const webEmail = typeof me.email === "string" ? me.email.trim().toLowerCase() : "";
              const userID = String(me.userId ?? "");
              if (webEmail === email || !webEmail && /^[0-9]+$/.test(userID)) {
                const listed = (await get("/api/portal/teams")).teams;
                const team = Array.isArray(listed) ? listed.find(v => isRecord(v) && String(v.team_id) === selected) : null;
                let matches = webEmail === email;
                if (team && !webEmail) {
                  const members = (await get(`/api/portal/teams/${selected}/members`)).members;
                  matches = Array.isArray(members) && members.some(v => isRecord(v) && String(v.user_id) === userID &&
                    typeof v.email === "string" && v.email.trim().toLowerCase() === email);
                }
                if (team && matches) {
                  const quota = object((await get(`/api/portal/teams/${selected}/subscription-quota`)).subscription_quota);
                  if (typeof root.subs_tier_name === "string" && quota.tier === root.subs_tier_name) {
                    const amount = (v: unknown): number => {
                      const n = finiteNumber(v); return n !== null && n >= 0 ? n : invalid();
                    };
                    const percent = (used: unknown, limit: unknown) => {
                      const l = amount(limit); return l > 0 ? Math.min(100, amount(used) / l * 100) : invalid();
                    };
                    const weeklyReset = reset(amount(quota.weekly_resets_at));
                    const seconds = amount(quota.window_duration_secs);
                    const windowReset = quota.window_resets_at == null ? null : reset(amount(quota.window_resets_at));
                    let primary = percent(quota.window_weighted_used, quota.window_weighted_limit);
                    if (quota.window_resets_at != null && windowReset === null || windowReset === null && primary !== 0) invalid();
                    if (weeklyReset !== null && weeklyReset > now && Number.isSafeInteger(seconds) && seconds >= 60) {
                      if (windowReset !== null && windowReset <= now) primary = 0;
                      base.windows = [feedWindow(Math.round(seconds / 60), primary, windowReset !== null && windowReset > now ? windowReset : null, now),
                      feedWindow(10080, percent(quota.weekly_weighted_used, quota.weekly_weighted_limit), weeklyReset, now)];
                    }
                  }
                }
              }
            }
          } catch { /* Optional browser quota never replaces a valid CLI login with an error. */ }
        }
      }
      if (base.windows.length < 2) {
        try {
          const history = await localHistory(context);
          if (history) base.windows.push(history);
        } catch { /* Unreadable local history must not discard subscription usage. */ }
      }
      base.windows.sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
      for (const lane of base.windows) {
        if (lane.value && lane.value.length > 12) {
          const match = /^(\$?)([-+0-9.,e]+)(.*)$/.exec(lane.value);
          if (match) lane.value = `${match[1]}${Number(match[2].replace(/,/g, "")).toExponential(2)}${match[3]}`;
        }
      }
      if (base.windows.some(lane => lane.used_percent !== null && !Number.isFinite(lane.used_percent))) invalid();
      base.blocked ||= base.windows.some(w => (w.used_percent ?? 0) >= 100);
      return [base];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, windows: [], error: "sign in" }];
      throw error;
    }
  },
};
