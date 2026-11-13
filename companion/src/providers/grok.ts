import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { cookieHeader } from "../cookies.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";
function money(value: number): string {
  return Math.abs(value) < 1e8 ? `$${value.toFixed(2)}` : `$${value.toExponential(2)}`;
}


function object(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try { const data: unknown = JSON.parse(text); return isRecord(data) ? data : null; } catch { return null; }
}

export function parseGrokBilling(root: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(root)) return null;
  const config = isRecord(root.config) ? root.config : null;
  const cycle = config ? isRecord(config.currentPeriod) ? config.currentPeriod : null
    : isRecord(root.billingCycle) ? root.billingCycle : null;
  const currentEnd = isoToSeconds(cycle?.end ?? cycle?.billingPeriodEnd);
  const end = currentEnd ?? isoToSeconds(config?.billingPeriodEnd);
  const start = currentEnd === null ? isoToSeconds(config?.billingPeriodStart)
    : isoToSeconds(cycle?.start ?? cycle?.billingPeriodStart);
  const minutes = end !== null && start !== null && end > start && start <= now ? Math.floor((end - start) / 60) : null;
  const windows: FeedWindow[] = [];
  let used = config ? finiteNumber(config.creditUsagePercent) : isRecord(root.usage) && isRecord(root.usage.totalUsed)
    ? finiteNumber(root.usage.totalUsed.val) : null;
  if (config && used === null && isRecord(config.onDemandUsed) && isRecord(config.onDemandCap)) {
    const spent = finiteNumber(config.onDemandUsed.val); const cap = finiteNumber(config.onDemandCap.val);
    if (spent !== null && cap !== null && cap > 0) used = spent / cap * 100;
  }
  const limit = !config && isRecord(root.monthlyLimit) ? finiteNumber(root.monthlyLimit.val) : null;
  if (used !== null && (config || (limit !== null && limit > 0))) {
    windows.push(feedWindow(minutes, config ? used : used / limit! * 100, end, now, minutes === null ? "quota" : undefined));
  }
  const prepaid = config?.prepaidBalance;
  if (isRecord(prepaid)) {
    const cents = finiteNumber(prepaid.val ?? (Object.keys(prepaid).length === 0 ? 0 : null));
    if (cents !== null && Number.isSafeInteger(cents) && cents >= 0) windows.push(valueWindow("balance", money(cents / 100)));
  }
  return windows.length ? windows : null;
}

export function parseGrokWeb(bytes: Uint8Array, now: number): FeedWindow[] | null {
  const fields: { path: string; value: number; float: boolean }[] = [];
  const known = new Set(["1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.12", "1.6.1", "1.6.2", "1.6.3", "1.8.2", "1.8.3", "1.6.3.2", "1.6.3.3"]);
  function scan(data: Uint8Array, prefix: string, depth: number): boolean {
    if (depth > 5) return false;
    let i = 0;
    const varint = (): number | null => {
      let value = 0; let scale = 1;
      for (let n = 0; n < 10 && i < data.length; n++) {
        const byte = data[i++]; value += (byte & 127) * scale;
        if (!(byte & 128)) return Number.isSafeInteger(value) ? value : null;
        scale *= 128;
      }
      return null;
    };
    while (i < data.length) {
      const tag = varint(); if (tag === null || tag < 8) return false;
      const field = Math.floor(tag / 8); const wire = tag % 8;
      const path = prefix ? `${prefix}.${field}` : `${field}`;
      if (wire === 0) { const value = varint(); if (value === null) return false; fields.push({ path, value, float: false }); }
      else if (wire === 5) {
        if (i + 4 > data.length) return false;
        fields.push({ path, value: new DataView(data.buffer, data.byteOffset + i, 4).getFloat32(0, true), float: true }); i += 4;
      } else if (wire === 1) { if (i + 8 > data.length) return false; i += 8; }
      else if (wire === 2) {
        const length = varint(); if (length === null || length > data.length - i) return false;
        if (known.has(path) && !scan(data.subarray(i, i + length), path, depth + 1)) return false;
        i += length;
      } else return false;
    }
    return true;
  }
  if (bytes[0] === 0 || bytes[0] === 128) {
    let offset = 0;
    while (offset < bytes.length) {
      if (offset + 5 > bytes.length) return null;
      const flag = bytes[offset];
      const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0);
      offset += 5;
      if (size > bytes.length - offset) return null;
      const payload = bytes.subarray(offset, offset + size);
      if (flag === 128) {
        const status = new TextDecoder().decode(payload).match(/grpc-status:\s*(\d+)/i)?.[1];
        if (status && status !== "0") throw new HttpError("Grok", status === "16" || status === "7" ? 401 : 502);
      } else if (flag !== 0 || !scan(payload, "", 0)) return null;
      offset += size;
    }
  } else if (!scan(bytes, "", 0)) return null;
  const percents = fields.filter(f => f.float && f.path.split(".").at(-1) === "1" && Number.isFinite(f.value) && f.value >= 0 && f.value <= 100)
    .sort((a, b) => a.path.split(".").length - b.path.split(".").length);
  const resets = fields.filter(f => !f.float && f.value > now && f.value >= 1700000000 && f.value <= 2100000000);
  const reset = resets.find(f => f.path === "1.5.1")?.value ?? resets.sort((a, b) => a.value - b.value)[0]?.value ?? null;
  const hasPeriod = fields.some(f => !f.float && (f.path.startsWith("1.6.") || (f.path === "1.8.1" && [1, 2].includes(f.value))));
  const currentStart = fields.find(f => !f.float && f.path === "1.8.2.1")?.value;
  const currentEnd = fields.find(f => !f.float && f.path === "1.8.3.1")?.value;
  const active = currentStart !== undefined && currentStart <= now && currentEnd !== undefined && currentEnd > now;
  const percent = percents[0]?.value ?? (!fields.some(f => f.float) && reset !== null && hasPeriod && active ? 0 : null);
  return percent === null ? null : [feedWindow(null, percent, reset, now, "quota")];
}

export const grok: Provider = {
  id: "grok", name: "Grok",
  async fetch(context) {
    const now = context.now();
    const configured = await apiKey(context, "grok", ["GROK_OAUTH_TOKEN"]);
    let credential: Record<string, unknown> | null = null;
    if (!configured) {
      const home = context.env.GROK_HOME || join(context.home, ".grok");
      const root = object(await context.readFile(join(home.startsWith("~/") ? join(context.home, home.slice(2)) : home, "auth.json")));
      const entries = Object.entries(root ?? {}).filter(([, value]) => isRecord(value) && typeof value.key === "string" && value.key.trim());
      const selected = entries.find(([scope]) => scope.startsWith("https://auth.x.ai::"))
        ?? entries.find(([scope]) => scope === "https://accounts.x.ai/sign-in" || scope.includes("/sign-in"));
      if (selected && isRecord(selected[1])) credential = selected[1];
    }
    const token = configured?.replace(/^Bearer\s+/i, "") ?? (typeof credential?.key === "string" ? credential.key : null);
    const base = { provider: "grok", account: accountLabel(typeof credential?.email === "string" ? credential.email : null),
      observed_at: new Date(now * 1000).toISOString(), blocked: false, windows: [] };
    const finish = (windows: FeedWindow[]) => [{ ...base, windows, blocked: windows.some(w => (w.used_percent ?? 0) >= 100) }];
    async function webBilling(auth: Record<string, string>): Promise<FeedWindow[]> {
    const response = await context.fetch("https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig", {
      method: "POST", headers: { ...auth, Origin: "https://grok.com", Referer: "https://grok.com/?_s=usage", Accept: "*/*",
        "Content-Type": "application/grpc-web+proto", "x-grpc-web": "1", "x-user-agent": "connect-es/2.1.1", "User-Agent": "CodexBar" },
      body: new Uint8Array([0, 0, 0, 0, 2, 8, 0]), signal: AbortSignal.timeout(30_000), redirect: "error",
    });
    if ([401, 403].includes(response.status) || ["16", "7"].includes(response.headers.get("grpc-status") ?? "")) throw new HttpError("Grok", 401);
    if (response.status === 429) throw new RateLimited("Grok", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Grok", response.status);
    try {
      const windows = parseGrokWeb(new Uint8Array(await response.arrayBuffer()), now);
      if (!windows) throw new HttpError("Grok", response.status);
      return windows;
    } catch (error) {
      throw error;
    }
    }
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1", clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } },
      { jsonrpc: "2.0", id: 2, method: "_x.ai/billing", params: {} },
    ].map(message => JSON.stringify(message)).join("\n") + "\n";
    const cli = await context.run("grok", ["agent", "stdio"], { timeoutMs: 10_000, input });
    if (cli?.code === 0) {
      for (const line of cli.stdout.split("\n")) {
        const message = object(line);
        if (message?.id !== 2) continue;
        const windows = parseGrokBilling(message.result, now);
        if (windows) return finish(windows);
      }
    }
    if (token) {
      const expiry = isoToSeconds(credential?.expires_at);
      if (expiry !== null && expiry <= now) return [{ ...base, error: "sign in" }];
      const response = await context.fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
        headers: { Authorization: `Bearer ${token}`, "x-xai-token-auth": "xai-grok-cli", Accept: "application/json", "User-Agent": "CodexBar" },
        signal: AbortSignal.timeout(30_000), redirect: "error",
      });
      if ([401, 403].includes(response.status)) return [{ ...base, error: "sign in" }];
      if (response.status === 429) throw new RateLimited("Grok", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("Grok", response.status);
      let json: unknown;
      try { json = await response.json(); } catch { throw new HttpError("Grok", response.status); }
      if (!isRecord(json) || !isRecord(json.config)) throw new HttpError("Grok", response.status);
      const windows = parseGrokBilling(json, now);
      if (windows?.some(window => window.used_percent !== null)) return finish(windows);
      try {
        const enriched = await webBilling({ Authorization: `Bearer ${token}` });
        const merged = parseGrokBilling({ ...json, config: { ...json.config, creditUsagePercent: enriched[0].used_percent } }, now);
        return finish(merged ?? enriched);
      } catch (error) {
        if (windows && error instanceof HttpError && error.status === 200) return finish(windows);
        if (error instanceof HttpError && [401, 403].includes(error.status)) return [{ ...base, error: "sign in" }];
        throw error;
      }
    }
    const cookie = await cookieHeader(context, "grok", { domains: ["grok.com", "www.grok.com"], required: ["sso", "sso-rw"] });
    if (!cookie) {
      if (cli && /authentication required|grok login/i.test(cli.stdout + cli.stderr)) return [{ ...base, error: "sign in" }];
      if (cli) throw new HttpError("Grok", 502);
      throw new NotConfigured("Grok");
    }
    try { return finish(await webBilling({ Cookie: cookie })); }
    catch (error) {
      if (error instanceof HttpError && error.status === 401) return [{ ...base, error: "sign in" }];
      throw error;
    }

  },
};
