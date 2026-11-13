import { isAbsolute, join, relative } from "node:path";
import { accountLabel, finiteNumber, isoToSeconds, isRecord, valueWindow } from "../feed.ts";
import { HttpError, NotConfigured, type Context, type Provider } from "./types.ts";

function object(text: string): Record<string, unknown> | null {
  try {
    const root: unknown = JSON.parse(text);
    return isRecord(root) ? root : null;
  } catch {
    return null;
  }
}

function tokenCount(usage: Record<string, unknown>): number | null {
  let present = false;
  const read = (keys: string[], source = usage): number | null => {
    for (const key of keys)
      if (Object.hasOwn(source, key)) {
        present = true;
        const value = finiteNumber(source[key]);
        return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
      }
    return 0;
  };
  const input = read(["input", "inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const output = read(["output", "outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const cacheRead = read([
    "cacheRead",
    "cacheReadTokens",
    "cache_read",
    "cache_read_tokens",
    "cacheReadInputTokens",
    "cache_read_input_tokens",
  ]);
  const cacheWrite = read([
    "cacheWrite",
    "cacheWriteTokens",
    "cache_write",
    "cache_write_tokens",
    "cacheCreationTokens",
    "cache_creation_tokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
  ]);
  const cttl = isRecord(usage.cttl) ? usage.cttl : {};
  const longWrite =
    Object.hasOwn(usage, "cacheWrite1h") || Object.hasOwn(usage, "cache_write_1h")
      ? read(["cacheWrite1h", "cache_write_1h"])
      : read(["ephemeral1h", "ephemeral_1h"], cttl);
  const total = read(["totalTokens", "total_tokens", "tokenCount", "token_count", "tokens"]);
  if (
    !present ||
    input === null ||
    output === null ||
    cacheRead === null ||
    cacheWrite === null ||
    total === null ||
    longWrite === null ||
    longWrite > cacheWrite
  )
    return null;
  const value = Math.max(total, input + output + cacheRead + cacheWrite);
  return Number.isSafeInteger(value) ? value : null;
}

async function roots(context: Context): Promise<string[]> {
  const expand = (raw: string) => (raw.startsWith("~/") ? join(context.home, raw.slice(2)) : raw);
  const absolute = (raw: string) => {
    const path = expand(raw);
    if (!isAbsolute(path)) throw new HttpError("Pi", 200);
    return path;
  };
  const result: string[] = [];
  const agent = context.env.PI_CODING_AGENT_DIR ? absolute(context.env.PI_CODING_AGENT_DIR) : null;
  if (context.env.PI_CODING_AGENT_SESSION_DIR) result.push(absolute(context.env.PI_CODING_AGENT_SESSION_DIR));
  else result.push(join(agent ?? join(context.home, ".pi/agent"), "sessions"));
  const configName = context.env.PI_CONFIG_DIR || ".omp";
  const configRoot = join(context.home, configName);
  if (isAbsolute(configName) || relative(context.home, configRoot).startsWith("..")) throw new HttpError("Pi", 200);
  const dataHome = context.env.XDG_DATA_HOME ? absolute(context.env.XDG_DATA_HOME) : join(context.home, ".local/share");
  const profile = (context.env.OMP_PROFILE ?? context.env.PI_PROFILE ?? "").trim();
  if (profile && profile !== "default") {
    if (!/^[A-Za-z0-9_-]+$/.test(profile)) throw new HttpError("Pi", 200);
    for (const root of [configRoot, join(dataHome, "omp")]) {
      result.push(join(root, "profiles", profile, "sessions"), join(root, "profiles", profile, "agent/sessions"));
    }
  } else if (agent) result.push(join(agent, "sessions"));
  else {
    result.push(join(configRoot, "agent/sessions"), join(dataHome, "omp/sessions"));
    for (const root of [configRoot, join(dataHome, "omp")]) {
      for (const name of (await context.listDir(join(root, "profiles"))) ?? []) {
        if (/^[A-Za-z0-9_-]+$/.test(name))
          result.push(join(root, "profiles", name, "sessions"), join(root, "profiles", name, "agent/sessions"));
      }
    }
  }
  return [...new Set(result)];
}

export const pi: Provider = {
  id: "pi",
  name: "Pi",
  async fetch(context) {
    const now = context.now();
    const totals = [0, 0];
    const seen = new Set<string>();
    let detected = false;
    let count = 0;
    async function scan(directory: string, depth: number): Promise<void> {
      if (depth > 3) throw new HttpError("Pi", 200);
      const entries = await context.listDir(directory);
      if (entries === null) return;
      detected = true;
      for (const name of entries) {
        if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) continue;
        if (++count > 20000) throw new HttpError("Pi", 200);
        const path = join(directory, name);
        if (!name.endsWith(".jsonl")) {
          await scan(path, depth + 1);
          continue;
        }
        const text = await context.readFile(path);
        if (text === null) throw new HttpError("Pi", 200);
        let session: string | null = null;
        let lineIndex = 0;
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          lineIndex++;
          const entry = object(line);
          if (!entry) throw new HttpError("Pi", 200);
          if (entry.type === "session") {
            session = typeof entry.id === "string" ? entry.id : null;
            continue;
          }
          const message = entry.message;
          if (!isRecord(message) || message.role !== "assistant") continue;
          const timestamp =
            typeof message.timestamp === "number"
              ? message.timestamp / 1000
              : (isoToSeconds(message.timestamp) ??
                (typeof entry.timestamp === "number" ? entry.timestamp / 1000 : isoToSeconds(entry.timestamp)));
          if (timestamp === null || !Number.isFinite(timestamp)) throw new HttpError("Pi", 200);
          if (timestamp > now || timestamp < now - 7 * 86400) continue;
          const id = `${session ?? path}:${typeof entry.id === "string" ? entry.id : lineIndex}`;
          if (seen.has(id)) continue;
          const tokens = isRecord(message.usage) ? tokenCount(message.usage) : null;
          if (tokens === null) throw new HttpError("Pi", 200);
          seen.add(id);
          if (timestamp >= now - 86400) totals[0] += tokens;
          totals[1] += tokens;
          if (!totals.every(Number.isSafeInteger)) throw new HttpError("Pi", 200);
        }
      }
    }
    for (const root of await roots(context)) await scan(root, 0);
    if (!detected) throw new NotConfigured("Pi");
    const format = (value: number) =>
      value >= 1e12
        ? `${value.toExponential(1)} tok`
        : value >= 1e9
          ? `${(value / 1e9).toFixed(1)}B tok`
          : value >= 1e6
            ? `${(value / 1e6).toFixed(1)}M tok`
            : value >= 1e3
              ? `${(value / 1e3).toFixed(1)}k tok`
              : `${value} tok`;
    return [
      {
        provider: "pi",
        account: accountLabel(null),
        blocked: false,
        observed_at: new Date(now * 1000).toISOString(),
        windows: [valueWindow("1d", format(totals[0])), valueWindow("7d", format(totals[1]))],
      },
    ];
  },
};
