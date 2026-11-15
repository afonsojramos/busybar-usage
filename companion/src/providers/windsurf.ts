import { join } from "node:path";
import { browserLocalStorage } from "../browser-local-storage.ts";
import { cookieHeader } from "../cookies.ts";
import { providerEntry } from "../keys.ts";
import { accountLabel, feedWindow, finiteNumber, isRecord, type FeedAccount, type FeedWindow } from "../feed.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const NAME = "Windsurf";
const QUERY = "SELECT value FROM ItemTable WHERE key = 'windsurf.settings.cachedPlanInfo' LIMIT 1;";
type ProtoField =
  | { number: number; kind: "number"; value: number }
  | { number: number; kind: "bytes"; value: Uint8Array };

function fields(data: Uint8Array): ProtoField[] {
  let offset = 0;
  function varint(): number {
    let result = 0n;
    for (let shift = 0n; shift < 70n && offset < data.length; shift += 7n) {
      const byte = data[offset++];
      if (byte === undefined) break;
      result |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(NAME, 200);
        return Number(result);
      }
    }
    throw new HttpError(NAME, 200);
  }
  const out: ProtoField[] = [];
  while (offset < data.length) {
    const key = varint();
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (number === 0) throw new HttpError(NAME, 200);
    if (wire === 0) out.push({ number, kind: "number", value: varint() });
    else if (wire === 2) {
      const length = varint();
      if (offset + length > data.length) throw new HttpError(NAME, 200);
      out.push({ number, kind: "bytes", value: data.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > data.length) throw new HttpError(NAME, 200);
    } else throw new HttpError(NAME, 200);
  }
  return out;
}

export function parsePlanStatus(data: Uint8Array, now: number): FeedWindow[] | null {
  const status = fields(data).find((f) => f.number === 1 && f.kind === "bytes");
  if (!status || status.kind !== "bytes") return null;
  const plan = fields(status.value);
  const number = (n: number) => {
    const field = plan.find((f) => f.number === n && f.kind === "number");
    return field?.kind === "number" ? field.value : null;
  };
  const windows: FeedWindow[] = [];
  for (const [usageKey, resetKey, minutes] of [
    [14, 17, 1440],
    [15, 18, 10080],
  ]) {
    if (usageKey === undefined || resetKey === undefined || minutes === undefined) continue;
    const remaining = number(usageKey);
    if (remaining !== null)
      windows.push(feedWindow(minutes, Math.max(0, Math.min(100, 100 - remaining)), number(resetKey), now));
  }
  return windows.length ? windows : null;
}

export function parseCachedPlan(json: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(json)) return null;
  const quota = isRecord(json.quotaUsage) ? json.quotaUsage : {};
  const usage = isRecord(json.usage) ? json.usage : {};
  const windows: FeedWindow[] = [];
  for (const [prefix, minutes, totalKey, usedKey, remainingKey, label] of [
    ["daily", 1440, "messages", "usedMessages", "remainingMessages", "msgs"],
    ["weekly", 10080, "flowActions", "usedFlowActions", "remainingFlowActions", "flows"],
  ] as const) {
    const remaining = finiteNumber(quota[`${prefix}RemainingPercent`]);
    if (remaining !== null) {
      windows.push(
        feedWindow(
          minutes,
          Math.max(0, Math.min(100, 100 - remaining)),
          finiteNumber(quota[`${prefix}ResetAtUnix`]),
          now,
        ),
      );
      continue;
    }
    const total = finiteNumber(usage[totalKey]);
    const left = finiteNumber(usage[remainingKey]);
    const used = finiteNumber(usage[usedKey]) ?? (total !== null && left !== null ? total - left : null);
    if (total !== null && total > 0 && used !== null)
      windows.push(feedWindow(null, Math.max(0, Math.min(100, (used / total) * 100)), null, now, label));
  }
  return windows.length ? windows : null;
}

async function local(context: Context): Promise<FeedWindow[] | null> {
  const rows = await context.querySqlite(
    join(context.home, "Library/Application Support/Windsurf/User/globalStorage/state.vscdb"),
    QUERY,
  );
  const value = rows?.[0]?.value;
  const texts =
    typeof value === "string"
      ? [value]
      : value instanceof Uint8Array
        ? [Buffer.from(value).toString("utf8"), Buffer.from(value).toString("utf16le")]
        : [];
  for (const text of texts) {
    try {
      const json: unknown = JSON.parse(text.replace(/^\uFEFF/, "").replace(/\0+$/, ""));
      const windows = parseCachedPlan(json, context.now());
      if (windows) return windows;
    } catch {
      continue;
    }
  }
  return null;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}

export const windsurf: Provider = {
  id: "windsurf",
  name: NAME,
  async fetch(context): Promise<FeedAccount[]> {
    const entry = await providerEntry(context, "windsurf");
    const now = context.now();
    const base: FeedAccount = {
      provider: "windsurf",
      account: accountLabel(null),
      observed_at: new Date(now * 1000).toISOString(),
      blocked: false,
      windows: [],
    };
    let raw =
      entry.cookieSource === "off" || entry.usageDataSource === "cli"
        ? null
        : await cookieHeader(context, "windsurf", { domains: [] });
    if (!raw && entry.cookieSource !== "off" && entry.cookieSource !== "manual" && entry.usageDataSource !== "cli") {
      const keys = ["devin_session_token", "devin_auth1_token", "devin_account_id", "devin_primary_org_id"];
      for (const origin of ["https://app.devin.ai", "https://windsurf.com"]) {
        const values = await browserLocalStorage(
          context,
          origin,
          (key) => keys.includes(key),
          (entries) => keys.every((key) => !!entries.get(key)?.trim()),
        );
        if (!values) continue;
        raw = JSON.stringify(
          Object.fromEntries(
            [...values].map(([key, value]) => {
              try {
                const decoded: unknown = JSON.parse(value);
                if (typeof decoded === "string") return [key, decoded.trim()];
              } catch {
                /* Unquoted values are valid. */
              }
              return [key, value.trim()];
            }),
          ),
        );
        break;
      }
    }
    if (entry.cookieSource === "manual" && !raw && entry.usageDataSource === "web") throw new NotConfigured(NAME);
    if (raw) {
      try {
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new NotConfigured(NAME);
        }
        if (!isRecord(json)) throw new NotConfigured(NAME);
        const token = json.devin_session_token;
        const auth = json.devin_auth1_token;
        const account = json.devin_account_id;
        const org = json.devin_primary_org_id;
        if (
          typeof token !== "string" ||
          !token.trim() ||
          typeof auth !== "string" ||
          !auth.trim() ||
          typeof account !== "string" ||
          !account.trim() ||
          typeof org !== "string" ||
          !org.trim()
        )
          throw new NotConfigured(NAME);
        const bytes = Buffer.from(token, "utf8");
        const response = await context.fetch(
          "https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/GetPlanStatus",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/proto",
              "Connect-Protocol-Version": "1",
              Origin: "https://windsurf.com",
              Referer: "https://windsurf.com/profile",
              "x-auth-token": token,
              "x-devin-session-token": token,
              "x-devin-auth1-token": auth,
              "x-devin-account-id": account,
              "x-devin-primary-org-id": org,
            },
            body: Buffer.concat([Buffer.from([10, ...varint(bytes.length)]), bytes, Buffer.from([16, 1])]),
            signal: AbortSignal.timeout(30_000),
            redirect: "error",
          },
        );
        if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
        if (response.status === 429) throw new RateLimited(NAME, now + retryAfterSeconds(response.headers, 300));
        if (!response.ok) throw new HttpError(NAME, response.status);
        const windows = parsePlanStatus(new Uint8Array(await response.arrayBuffer()), now);
        if (!windows) throw new HttpError(NAME, response.status);
        return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
      } catch (error) {
        if (
          error instanceof RateLimited ||
          (error instanceof Error && error.name === "AbortError") ||
          entry.usageDataSource === "web"
        )
          throw error;
        const windows = await local(context);
        if (!windows) throw error;
        return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
      }
    }
    if (entry.usageDataSource === "web") throw new NotConfigured(NAME);
    const windows = await local(context);
    if (!windows) throw new NotConfigured(NAME);
    return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
  },
};
