import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isRecord, valueWindow, type FeedAccount } from "../feed.ts";
import { providerEntry, resolveKey } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  isProviderHost,
  retryAfterSeconds,
  type Context,
  type Provider,
} from "./types.ts";

const NAME = "Bedrock";
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
class SignIn extends Error {}
interface Credentials {
  accessKey: string;
  secretKey: string;
  sessionToken: string | null;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const encode = (value: string) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

export function signedHeaders(
  url: URL,
  body: string,
  credentials: Credentials,
  region: string,
  service: string,
  now: number,
  target: string,
): Record<string, string> {
  const date = new Date(now * 1000).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = date.slice(0, 8);
  const headers: Record<string, string> = {
    "content-type": service === "ce" ? "application/x-amz-json-1.1" : "application/x-amz-json-1.0",
    host: url.host,
    "x-amz-date": date,
    "x-amz-target": target,
    "x-amz-content-sha256": hash(body),
  };
  if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;
  const keys = Object.keys(headers).sort();
  const signed = keys.join(";");
  const query = [...url.searchParams.entries()]
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .sort()
    .join("&");
  const path = url.pathname
    .split("/")
    .map((part) => encode(decodeURIComponent(part)))
    .join("/");
  const canonical = [
    "POST",
    path,
    query,
    keys.map((key) => `${key}:${headers[key].trim()}`).join("\n") + "\n",
    signed,
    hash(body),
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  let key = createHmac("sha256", `AWS4${credentials.secretKey}`).update(day).digest();
  for (const part of [region, service, "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key)
    .update(["AWS4-HMAC-SHA256", date, scope, hash(canonical)].join("\n"))
    .digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return headers;
}

function cloudWatchHost(region: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+-[0-9]+$/.test(region)) throw new NotConfigured(NAME);
  const partitions = [
    ["cn-", "amazonaws.com.cn"],
    ["eusc-", "amazonaws.eu"],
    ["us-iso-", "c2s.ic.gov"],
    ["us-isob-", "sc2s.sgov.gov"],
    ["eu-isoe-", "cloud.adc-e.uk"],
    ["us-isof-", "csp.hci.ic.gov"],
  ];
  return `monitoring.${region}.${partitions.find(([prefix]) => region.startsWith(prefix))?.[1] ?? "amazonaws.com"}`;
}

function endpoint(override: string | undefined, host: string): URL {
  let url: URL;
  try {
    url = new URL(override ?? `https://${host}`);
  } catch {
    throw new NotConfigured(NAME);
  }
  if (!isProviderHost(url, [host]) || url.username || url.password || url.hash) throw new NotConfigured(NAME);
  return url;
}

async function request(
  context: Context,
  url: URL,
  credentials: Credentials,
  region: string,
  service: string,
  target: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(payload);
  const response = await context.fetch(url, {
    method: "POST",
    body,
    headers: signedHeaders(url, body, credentials, region, service, context.now(), target),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401 || response.status === 403) throw new SignIn();
  if (response.status === 429) throw new RateLimited(NAME, context.now() + retryAfterSeconds(response.headers, 300));
  if (!response.ok) throw new HttpError(NAME, response.status);
  const result: unknown = await response.json().catch(() => null);
  if (!isRecord(result)) throw new HttpError(NAME, response.status);
  return result;
}

async function credentials(context: Context, entry: Record<string, unknown>) {
  const access = await resolveKey(context, "bedrock", ["AWS_ACCESS_KEY_ID"]);
  const secret = text(context.env.AWS_SECRET_ACCESS_KEY) ?? text(entry.secretKey);
  const profile = text(entry.awsProfile) ?? text(context.env.AWS_PROFILE);
  const configuredMode = text(entry.awsAuthMode) ?? text(context.env.CODEXBAR_BEDROCK_AUTH_MODE)?.toLowerCase();
  const mode =
    configuredMode === "profile" || configuredMode === "keys"
      ? configuredMode
      : profile && !(access && secret)
        ? "profile"
        : "keys";
  let region = text(entry.region) ?? text(context.env.AWS_REGION) ?? text(context.env.AWS_DEFAULT_REGION);
  if (mode === "keys") {
    if (!access || !secret) throw new NotConfigured(NAME);
    return {
      credentials: { accessKey: access.key, secretKey: secret, sessionToken: text(context.env.AWS_SESSION_TOKEN) },
      region: region ?? "us-east-1",
    };
  }
  if (!profile) throw new NotConfigured(NAME);
  const binaries = context.env.AWS_CLI_PATH
    ? [context.env.AWS_CLI_PATH]
    : ["aws", "/opt/homebrew/bin/aws", "/usr/local/bin/aws", join(context.home, ".local", "bin", "aws")];
  // Context overlays cannot unset AWS_PROFILE; an empty value avoids overriding --profile.
  const options = { timeoutMs: 20000, env: { AWS_PROFILE: "", AWS_CLI_AUTO_PROMPT: "off", AWS_PAGER: "" } };
  for (const binary of binaries) {
    const result = await context.run(
      binary,
      ["configure", "export-credentials", "--profile", profile, "--format", "process"],
      options,
    );
    if (!result) continue;
    if (result.code !== 0) {
      if (/sso login|expired/i.test(result.stderr)) throw new SignIn();
      throw new HttpError(NAME, 0);
    }
    let exported: unknown;
    try {
      exported = JSON.parse(result.stdout);
    } catch {
      throw new HttpError(NAME, 0);
    }
    if (!isRecord(exported)) throw new HttpError(NAME, 0);
    const accessKey = text(exported.AccessKeyId);
    const secretKey = text(exported.SecretAccessKey);
    if (!accessKey || !secretKey) throw new HttpError(NAME, 0);
    if (!region) {
      const configured = await context.run(binary, ["configure", "get", "region", "--profile", profile], options);
      region = configured?.code === 0 ? text(configured.stdout) : null;
    }
    return {
      credentials: { accessKey, secretKey, sessionToken: text(exported.SessionToken) },
      region: region ?? "us-east-1",
    };
  }
  throw new NotConfigured(NAME);
}

function nextToken(body: Record<string, unknown>, key: string): string | null {
  if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string") throw new HttpError(NAME, 200);
  return text(body[key]);
}

async function monthlySpend(context: Context, credentials: Credentials, url: URL): Promise<number> {
  const now = new Date(context.now() * 1000);
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const period = { Start: `${now.toISOString().slice(0, 7)}-01`, End: tomorrow.toISOString().slice(0, 10) };
  const seen = new Set<string>();
  let token: string | null = null;
  let total = 0;
  for (let page = 0; page < 100; page++) {
    const body = await request(
      context,
      url,
      credentials,
      "us-east-1",
      "ce",
      "AWSInsightsIndexService.GetCostAndUsage",
      {
        TimePeriod: period,
        Granularity: "MONTHLY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        ...(token ? { NextPageToken: token } : {}),
      },
    );
    if (!Array.isArray(body.ResultsByTime)) throw new HttpError(NAME, 200);
    for (const row of body.ResultsByTime) {
      if (!isRecord(row)) throw new HttpError(NAME, 200);
      if (row.Groups === undefined) continue;
      if (!Array.isArray(row.Groups)) throw new HttpError(NAME, 200);
      for (const group of row.Groups) {
        if (!isRecord(group) || !Array.isArray(group.Keys)) throw new HttpError(NAME, 200);
        const service: unknown = group.Keys[0];
        if (typeof service !== "string" || !/bedrock/i.test(service)) continue;
        const metric = isRecord(group.Metrics) ? group.Metrics.UnblendedCost : null;
        const amount = isRecord(metric) ? finiteNumber(metric.Amount) : null;
        if (amount === null) throw new HttpError(NAME, 200);
        total += amount;
      }
    }
    token = nextToken(body, "NextPageToken");
    if (!Number.isFinite(total)) throw new HttpError(NAME, 200);
    if (!token) return total;
    if (seen.has(token)) throw new HttpError(NAME, 200);
    seen.add(token);
  }
  throw new HttpError(NAME, 200);
}

async function activity(context: Context, credentials: Credentials, region: string, url: URL): Promise<number> {
  const totals = { inputTokens: 0, outputTokens: 0, requests: 0 };
  const seen = new Set<string>();
  let token: string | null = null;
  for (let page = 0; page < 20; page++) {
    const body = await request(
      context,
      url,
      credentials,
      region,
      "monitoring",
      "GraniteServiceVersion20100801.GetMetricData",
      {
        StartTime: context.now() - 14 * 86400,
        EndTime: context.now(),
        ScanBy: "TimestampAscending",
        MetricDataQueries: [
          ["inputTokens", "InputTokenCount"],
          ["outputTokens", "OutputTokenCount"],
          ["requests", "Invocations"],
        ].map(([id, name]) => ({
          Id: id,
          Expression: `SUM(SEARCH('{AWS/Bedrock,ModelId} MetricName="${name}" claude', 'Sum', 86400))`,
          ReturnData: true,
        })),
        ...(token ? { NextToken: token } : {}),
      },
    );
    if (Array.isArray(body.Messages) && body.Messages.length > 0) throw new HttpError(NAME, 200);
    if (!Array.isArray(body.MetricDataResults)) throw new HttpError(NAME, 200);
    for (const result of body.MetricDataResults) {
      if (!isRecord(result) || result.StatusCode !== "Complete" || !Array.isArray(result.Values))
        throw new HttpError(NAME, 200);
      const id = result.Id;
      if (id !== "inputTokens" && id !== "outputTokens" && id !== "requests") throw new HttpError(NAME, 200);
      for (const value of result.Values) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new HttpError(NAME, 200);
        totals[id] += value;
        if (!Number.isSafeInteger(Math.round(totals[id]))) throw new HttpError(NAME, 200);
      }
    }
    token = nextToken(body, "NextToken");
    if (!token) return Math.round(totals.inputTokens) + Math.round(totals.outputTokens);
    if (seen.has(token)) throw new HttpError(NAME, 200);
    seen.add(token);
  }
  throw new HttpError(NAME, 200);
}

function dollars(amount: number): string {
  const value = `$${amount.toFixed(2)}`;
  return value.length <= 12 ? value : `$${amount.toExponential(2)}`;
}

export const bedrock: Provider = {
  id: "bedrock",
  name: NAME,
  // Each Cost Explorer request costs $0.01, and its data changes a few times a day.
  minIntervalSeconds: 3600,
  async fetch(context): Promise<FeedAccount[]> {
    const base = {
      provider: "bedrock",
      provider_name: NAME,
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(context.now() * 1000).toISOString(),
      windows: [],
    };
    try {
      const entry = await providerEntry(context, "bedrock");
      const resolved = await credentials(context, entry);
      const costURL = endpoint(context.env.CODEXBAR_BEDROCK_API_URL, "ce.us-east-1.amazonaws.com");
      const cloudURL = endpoint(context.env.CODEXBAR_BEDROCK_CLOUDWATCH_API_URL, cloudWatchHost(resolved.region));
      const spend = await monthlySpend(context, resolved.credentials, costURL);
      let tokens: number | null = null;
      if (!context.env.CODEXBAR_BEDROCK_API_URL || context.env.CODEXBAR_BEDROCK_CLOUDWATCH_API_URL) {
        try {
          tokens = await activity(context, resolved.credentials, resolved.region, cloudURL);
        } catch (error) {
          if (!(error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError"))) throw error;
          // A transient CloudWatch transport failure must not hide measured spend.
        }
      }
      const budget = finiteNumber(context.env.CODEXBAR_BEDROCK_BUDGET);
      const windows = [];
      if (budget !== null && budget > 0) {
        const date = new Date(context.now() * 1000);
        const reset = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
        windows.push(
          feedWindow(null, Math.min(100, Math.max(0, (spend / budget) * 100)), reset, context.now(), "month"),
        );
      }
      windows.push(valueWindow("spend", dollars(spend)));
      if (windows.length < 2 && tokens !== null)
        windows.push(
          valueWindow(
            "14d tok",
            Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(tokens),
          ),
        );
      return [{ ...base, windows, blocked: windows.some((window) => (window.used_percent ?? 0) >= 100) }];
    } catch (error) {
      if (error instanceof SignIn) return [{ ...base, error: "sign in" }];
      throw error;
    }
  },
};
