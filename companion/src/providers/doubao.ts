import { createHash, createHmac } from "node:crypto";
import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isoToSeconds,
  isRecord,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "doubao";

function base(context: Context): FeedAccount {
  return {
    provider: ID,
    account: accountLabel(null),
    blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(),
    windows: [],
  };
}

async function request(context: Context, url: string | URL, key: string, init: RequestInit = {}): Promise<unknown> {
  const response = await context.fetch(url, {
    ...init,
    redirect: "error",
    headers: { Accept: "application/json", Authorization: `Bearer ${key}`, ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403) throw new HttpError(ID, response.status);
  if (response.status === 429) throw new RateLimited(ID, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(ID, response.status);
  try {
    return await response.json();
  } catch {
    throw new HttpError(ID, response.status);
  }
}

function finish(context: Context, windows: FeedWindow[], blocked = false): FeedAccount[] {
  return [
    {
      ...base(context),
      windows: windows.slice(0, 2),
      blocked: blocked || windows.some((window) => (window.used_percent ?? 0) >= 100),
    },
  ];
}

function signIn(context: Context, error: unknown): FeedAccount[] {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return [{ ...base(context), error: "sign in" }];
  }
  throw error;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(ID, 200);
  return value;
}

function number(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null) throw new HttpError(ID, 200);
  return parsed;
}

function numberOrNull(value: unknown): number {
  return finiteNumber(value) ?? 0;
}
function epoch(value: unknown, milliseconds = false): number | null {
  const n = finiteNumber(value);
  return n !== null && n > 0 ? n / (milliseconds || n >= 1e11 ? 1000 : 1) : isoToSeconds(value);
}
interface Plan {
  product: string;
  windows: FeedWindow[];
}
function periods(rows: unknown[], context: Context): FeedWindow[] {
  const lanes: FeedWindow[] = [];
  for (const raw of rows) {
    const row = object(raw);
    const label = row.label ?? row.Level;
    const minutes = ["session", "5-hour", "five_hour", "5h"].includes(String(label))
      ? 300
      : ["weekly", "week"].includes(String(label))
        ? 10080
        : ["monthly", "month"].includes(String(label))
          ? 43200
          : null;
    if (minutes === null) continue;
    const percent = row.percent ?? row.Percent;
    if (typeof percent !== "number" || !Number.isFinite(percent)) throw new HttpError(ID, 200);
    lanes.push(
      feedWindow(
        minutes,
        Math.max(0, Math.min(100, percent)),
        epoch(row.reset_at ?? row.ResetTimestamp),
        context.now(),
      ),
    );
  }
  return lanes.sort((a, b) => number(a.minutes) - number(b.minutes));
}
function signedHeaders(
  context: Context,
  action: string,
  access: string,
  secret: string,
  region: string,
): Record<string, string> {
  const timestamp = new Date(context.now() * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  const date = timestamp.slice(0, 8),
    contentType = "application/x-www-form-urlencoded; charset=utf-8";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const hash = sha("");
  const headers = "content-type;host;x-content-sha256;x-date";
  const canonical = [
    "POST",
    "/",
    `Action=${action}&Version=2024-01-01`,
    `content-type:${contentType}`,
    "host:open.volcengineapi.com",
    `x-content-sha256:${hash}`,
    `x-date:${timestamp}`,
    "",
    headers,
    hash,
  ].join("\n");
  const scope = `${date}/${region}/ark/request`;
  const text = ["HMAC-SHA256", timestamp, scope, sha(canonical)].join("\n");
  let signingKey = Buffer.from(secret);
  for (const part of [date, region, "ark", "request"])
    signingKey = Buffer.from(createHmac("sha256", signingKey).update(part).digest());
  const signature = createHmac("sha256", signingKey).update(text).digest("hex");
  return {
    "Content-Type": contentType,
    Host: "open.volcengineapi.com",
    "X-Date": timestamp,
    "X-Content-Sha256": hash,
    Authorization: `HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${headers}, Signature=${signature}`,
  };
}
export const doubao: Provider = {
  id: ID,
  name: "Doubao",
  async fetch(context) {
    const key = await apiKey(context, ID, ["ARK_API_KEY", "VOLCENGINE_API_KEY", "DOUBAO_API_KEY"]);
    const entry = await providerEntry(context, ID);
    const first = (names: string[]) => names.map((n) => context.env[n]?.trim()).find(Boolean);
    const configuredArkKey = typeof entry.apiKey === "string" && !entry.apiKey.startsWith("AKLT");
    const access = configuredArkKey
      ? null
      : first(["VOLCENGINE_ACCESS_KEY_ID", "VOLCENGINE_ACCESS_KEY", "VOLC_ACCESSKEY", "DOUBAO_ACCESS_KEY_ID"]) ||
        (typeof entry.apiKey === "string" && entry.apiKey.startsWith("AKLT") ? entry.apiKey : null);
    const secret = configuredArkKey
      ? null
      : first([
          "VOLCENGINE_SECRET_ACCESS_KEY",
          "VOLCENGINE_SECRET_KEY",
          "VOLCENGINE_ACCESS_KEY_SECRET",
          "VOLC_SECRETKEY",
          "DOUBAO_SECRET_ACCESS_KEY",
        ]) || entry.secretKey;
    const region =
      first(["VOLCENGINE_REGION", "VOLCENGINE_REGION_ID", "VOLC_REGION", "DOUBAO_REGION"]) ||
      (typeof entry.region === "string" ? entry.region : "cn-beijing");
    try {
      if (typeof access === "string" && typeof secret === "string" && access && secret) {
        const get = async (action: string) =>
          object(
            object(
              await request(context, `https://open.volcengineapi.com/?Action=${action}&Version=2024-01-01`, "", {
                method: "POST",
                body: "",
                headers: signedHeaders(context, action, access, secret, region),
              }),
            ).Result,
          );
        const coding = await get("GetCodingPlanUsage");
        if (coding.QuotaUsage != null && !Array.isArray(coding.QuotaUsage)) throw new HttpError(ID, 200);
        const windows = periods(Array.isArray(coding.QuotaUsage) ? coding.QuotaUsage : [], context);
        let agent: FeedWindow[] = [];
        try {
          const data = await get("GetAFPUsage");
          for (const [field, minutes] of [
            ["AFPFiveHour", 300],
            ["AFPWeekly", 10080],
            ["AFPMonthly", 43200],
          ] satisfies [string, number][]) {
            if (data[field] == null) continue;
            const lane = object(data[field]);
            const quota = number(lane.Quota),
              used = number(lane.Used);
            if (quota > 0)
              agent.push(feedWindow(minutes, (used / quota) * 100, epoch(lane.ResetTime, true), context.now()));
          }
        } catch (error) {
          if (
            error instanceof RateLimited ||
            (error instanceof HttpError && [401, 403].includes(error.status)) ||
            (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) ||
            !windows.length
          )
            throw error;
        }
        return finish(context, windows.length ? windows : agent);
      }
      if (key) {
        const probe = (model: string) =>
          context.fetch("https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions", {
            method: "POST",
            redirect: "error",
            headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
            body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
            signal: AbortSignal.timeout(30_000),
          });
        let response: Response | null = null;
        for (const model of ["doubao-seed-2.0-code", "doubao-1.5-pro-32k", "doubao-lite-32k"]) {
          response = await probe(model);
          if (response.status === 404) continue;
          // Two successful zero-remaining probes mean Ark's headers are unreliable.
          if (
            response.ok &&
            numberOrNull(response.headers.get("x-ratelimit-limit-requests")) > 0 &&
            finiteNumber(response.headers.get("x-ratelimit-remaining-requests")) === 0
          ) {
            try {
              const confirmation = await probe(model);
              if (
                confirmation.ok &&
                numberOrNull(confirmation.headers.get("x-ratelimit-limit-requests")) > 0 &&
                finiteNumber(confirmation.headers.get("x-ratelimit-remaining-requests")) === 0
              )
                return finish(context, []);
              response = confirmation;
            } catch (error) {
              if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
            }
          }
          break;
        }
        if (!response) throw new HttpError(ID, 0);
        if (response.status === 429)
          throw new RateLimited(ID, context.now() + retryAfterSeconds(response.headers, 300));
        if (!response.ok) throw new HttpError(ID, response.status);
        try {
          object(await response.json());
        } catch {
          throw new HttpError(ID, response.status);
        }
        const limit = finiteNumber(response.headers.get("x-ratelimit-limit-requests"));
        const remaining = finiteNumber(response.headers.get("x-ratelimit-remaining-requests"));
        const resetText = response.headers.get("x-ratelimit-reset-requests");
        let reset = isoToSeconds(resetText);
        if (reset === null && resetText) {
          const units: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };
          let seconds = 0;
          for (const match of resetText.matchAll(/(\d+)([dhms])/g)) seconds += Number(match[1]) * units[match[2]];
          reset = context.now() + (seconds || finiteNumber(resetText) || 0);
        }
        return finish(
          context,
          limit !== null && limit > 0 && remaining !== null
            ? [feedWindow(null, ((limit - remaining) / limit) * 100, reset, context.now(), "reqs")]
            : [],
        );
      }
      const result = await context.run(context.env.ARKCLI_PATH || "arkcli", ["usage", "plan", "--format", "json"], {
        timeoutMs: 15_000,
      });
      if (!result) throw new NotConfigured(ID);
      if (result.code !== 0) {
        if (
          /not logged in|not authenticated|authentication required|login required|please log ?in/i.test(result.stderr)
        )
          return [{ ...base(context), error: "sign in" }];
        throw new HttpError(ID, 0);
      }
      if (result.stdout.length > 256 * 1024) throw new HttpError(ID, 0);
      let raw: unknown;
      try {
        raw = JSON.parse(result.stdout);
      } catch {
        throw new HttpError(ID, 200);
      }
      const data = object(raw);
      if (isRecord(data.viewer) && data.viewer.auth_method === "none") return [{ ...base(context), error: "sign in" }];
      if (!Array.isArray(data.items)) throw new HttpError(ID, 200);
      const plans: Plan[] = [];
      for (const rawItem of data.items) {
        const item = object(rawItem);
        if (typeof item.product !== "string") throw new HttpError(ID, 200);
        const product = item.product.toLowerCase();
        if (
          !["coding-plan", "agent-plan", "coding-plan-team", "agent-plan-team"].includes(product) ||
          item.subscribed === false
        )
          continue;
        if (!Array.isArray(item.periods) || !item.periods.length) throw new HttpError(ID, 200);
        plans.push({ product, windows: periods(item.periods, context) });
      }
      const order = ["coding-plan", "agent-plan", "coding-plan-team", "agent-plan-team"];
      plans.sort((a, b) => order.indexOf(a.product) - order.indexOf(b.product));
      if (!plans.length) throw new HttpError(ID, 200);
      return finish(context, plans[0].windows);
    } catch (error) {
      return signIn(context, error);
    }
  },
};
