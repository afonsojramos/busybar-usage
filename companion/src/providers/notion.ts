import { accountLabel, feedWindow, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

class SignIn extends Error {}
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export const notion: Provider = {
  id: "notion",
  name: "Notion",
  async fetch(context): Promise<FeedAccount[]> {
    const now = context.now();
    const base: FeedAccount = {
      provider: "notion",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const invalid = (): never => {
      throw new HttpError("Notion", 200);
    };
    const object = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : invalid());
    const number = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : invalid());
    const decode = (text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        return invalid();
      }
    };
    const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const response = await context.fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status === 401 || response.status === 403) throw new SignIn();
      if (response.status === 429) throw new RateLimited("Notion", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Notion", response.status);
      return response;
    };
    try {
      const entry = await providerEntry(context, "notion");
      if (entry.cookieSource === "off") throw new NotConfigured("Notion");
      const cookieOptions = {
        domains: ["app.notion.com", "www.notion.com", "notion.com", "www.notion.so", "notion.so"],
        required: ["token_v2"],
      };
      let cookie: string | null = null;
      let savedSession = false;
      if (entry.cookieSource !== "off" && entry.cookieSource !== "manual" && !entry.cookieHeader) {
        const support =
          context.platform === "darwin"
            ? `${context.home}/Library/Application Support`
            : context.env.XDG_DATA_HOME || `${context.home}/.local/share`;
        const saved = await context.readFile(`${support}/CodexBar/notion-session.json`);
        if (saved) {
          let session: unknown;
          try {
            session = JSON.parse(saved);
          } catch {
            session = null;
          }
          if (isRecord(session) && typeof session.tokenV2 === "string" && session.tokenV2) {
            cookie = `token_v2=${session.tokenV2}`;
            savedSession = true;
          }
        }
      }
      cookie ??= await cookieHeader(context, "notion", cookieOptions);
      if (!cookie) throw new NotConfigured("Notion");
      const captured: Record<string, string> = {};
      if (/^curl\s/i.test(cookie.trim())) {
        for (const match of cookie.matchAll(/(?:-H|--header)\s+(['"])(.*?)\1/g)) {
          const field = /^([^:]+):\s*(.*)$/.exec(match[2]);
          if (field) captured[field[1].toLowerCase()] = field[2];
        }
        cookie = captured.cookie || "";
      }
      cookie = cookie.replace(/^Cookie:\s*/i, "").trim();
      if (!cookie) throw new NotConfigured("Notion");
      if (!cookie.includes("=")) cookie = `token_v2=${cookie}`;
      const headers: Record<string, string> = {
        Cookie: cookie,
        Accept: "*/*",
        "Content-Type": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://app.notion.com/",
        Origin: "https://app.notion.com",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
        "User-Agent": UA,
      };
      for (const name of [
        "accept",
        "accept-language",
        "notion-audit-log-platform",
        "notion-client-version",
        "referer",
        "sec-fetch-dest",
        "sec-fetch-mode",
        "sec-fetch-site",
        "user-agent",
        "x-notion-active-user-header",
      ]) {
        if (captured[name]) {
          const existing = Object.keys(headers).find((key) => key.toLowerCase() === name);
          if (existing) delete headers[existing];
          headers[name] = captured[name];
        }
      }
      const post = async (endpoint: string, body: Record<string, string>) =>
        object(
          decode(
            await (
              await request(`https://app.notion.com/api/v3/${endpoint}`, {
                method: "POST",
                headers,
                body: JSON.stringify(body),
              })
            ).text(),
          ),
        );
      const unwrap = (v: unknown): Record<string, unknown> | null => {
        if (!isRecord(v)) return null;
        if (!isRecord(v.value)) return v;
        return isRecord(v.value.value) ? v.value.value : v.value;
      };
      let spaces: Record<string, unknown>;
      try {
        spaces = await post("getSpaces", {});
      } catch (error) {
        if (!(error instanceof SignIn) || !savedSession) throw error;
        const fallback = await cookieHeader(context, "notion", cookieOptions);
        if (!fallback) throw error;
        headers.Cookie = fallback;
        spaces = await post("getSpaces", {});
      }
      const ids = Object.keys(spaces).filter((id) => {
        const container = spaces[id];
        const users = isRecord(container) ? container.notion_user : null;
        return isRecord(users) && unwrap(users[id])?.id === id;
      });
      const userID =
        ids.length === 1
          ? ids[0]
          : ids.length === 0 && Object.keys(spaces).length === 1
            ? Object.keys(spaces)[0]
            : invalid();
      const container = object(spaces[userID]);
      const users = isRecord(container.notion_user) ? container.notion_user : {};
      const user = unwrap(users[userID]) ?? Object.values(users).map(unwrap).find(Boolean);
      base.account = accountLabel(typeof user?.email === "string" ? user.email : null);
      const records = isRecord(container.space) ? container.space : {};
      const workspaces: Array<Record<string, unknown> & { id: string }> = Object.keys(records)
        .sort()
        .flatMap((key) => {
          const value = unwrap(records[key]);
          return value ? [{ ...value, id: typeof value.id === "string" ? value.id : key }] : [];
        });
      const normalize = (v: string) => v.trim().replace(/-/g, "").toLowerCase();
      const preferred = typeof entry.workspaceID === "string" ? normalize(entry.workspaceID) : "";
      const workspace =
        workspaces.find((w) => preferred && normalize(w.id) === preferred) ??
        workspaces.find((w) => ["business", "enterprise"].includes(String(w.subscription_tier).toLowerCase())) ??
        workspaces[0];
      if (!workspace) return invalid();
      const usage = await post("getCreditRateLimitStatus", { spaceId: workspace.id });
      if (usage.status === "not_applicable") return [{ ...base, error: "no quota" }];
      const parseWindow = (raw: unknown, rolling: boolean): FeedWindow | null => {
        if (raw == null) return null;
        const v = object(raw);
        for (const field of ["creditType", "scope", "window", "cadence"]) {
          if (v[field] != null && typeof v[field] !== "string") invalid();
        }
        const used = v.used == null ? null : number(v.used),
          limit = v.limit == null ? null : number(v.limit);
        if (used === null || limit === null || limit <= 0) return null;
        let minutes: number | null = rolling ? null : 43200;
        let reset: number | null = null;
        if (rolling) {
          const parts =
            typeof v.window === "string" ? /^([1-9][0-9]*)([mhdw])$/.exec(v.window.trim().toLowerCase()) : null;
          if (parts) {
            const unit = parts[2] === "m" ? 1 : parts[2] === "h" ? 60 : parts[2] === "d" ? 1440 : 10080;
            const parsed = Number(parts[1]) * unit;
            if (Number.isSafeInteger(parsed)) minutes = parsed;
          }
          if (usage.resetsInSeconds != null) {
            const seconds = number(usage.resetsInSeconds);
            if (seconds >= 0) reset = now + seconds;
          }
        } else if (v.periodEndMs != null) {
          const end = number(v.periodEndMs);
          if (end > 0) reset = end / 1000;
        }
        return feedWindow(
          minutes,
          (used / limit) * 100,
          reset,
          now,
          rolling && minutes === null ? "rolling" : undefined,
        );
      };
      if (usage.window == null && usage.billingPeriodWindow == null) invalid();
      base.windows = [parseWindow(usage.window, true), parseWindow(usage.billingPeriodWindow, false)]
        .filter((w): w is FeedWindow => w !== null)
        .sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
      base.blocked = ["exceeded_limit", "rate_limited", "limit_exceeded"].includes(String(usage.status));
      if (base.windows.some((lane) => lane.used_percent !== null && !Number.isFinite(lane.used_percent))) invalid();
      base.blocked ||= base.windows.some((w) => (w.used_percent ?? 0) >= 100);
      return [base];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, windows: [], error: "sign in" }];
      throw error;
    }
  },
};
