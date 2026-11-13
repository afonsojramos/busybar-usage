import type { Context, RunResult } from "../src/providers/types.ts";

export const NOW = 1_794_580_000;

export interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A context with in-memory files and Keychain items, and a fetch that answers from a queue. */
export function fakeContext(options: {
  files?: Record<string, string>;
  /** Binary files for readFileBytes; text files are also readable as bytes. */
  binaryFiles?: Record<string, Uint8Array>;
  /** Directory listings by path. */
  dirs?: Record<string, string[]>;
  /** Keychain items by service, or by "service/account" when an account is asked for. */
  keychain?: Record<string, string>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  responses?: Response[];
  /** Program results by "command arg1 arg2"; a missing entry means the program is not installed. */
  commands?: Record<string, RunResult>;
  /** Query results by "path::sql". */
  sqlite?: Record<string, Record<string, unknown>[]>;
}): Context & { calls: Call[]; runs: string[] } {
  const calls: Call[] = [];
  const runs: string[] = [];
  const responses = [...(options.responses ?? [])];
  return {
    calls,
    env: options.env ?? {},
    home: "/home/test",
    platform: options.platform ?? "linux",
    now: () => NOW,
    async fetch(input, init) {
      calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    },
    readFile: async (path) => options.files?.[path] ?? null,
    readFileBytes: async (path) =>
      options.binaryFiles?.[path] ?? (options.files?.[path] === undefined ? null : new TextEncoder().encode(options.files[path])),
    listDir: async (path) => options.dirs?.[path] ?? null,
    readKeychain: async (service, account) =>
      options.keychain?.[account === undefined ? service : `${service}/${account}`] ?? null,
    runs,
    async run(command, args) {
      const key = [command, ...args].join(" ");
      runs.push(key);
      return options.commands?.[key] ?? null;
    },
    querySqlite: async (path, sql) => options.sqlite?.[`${path}::${sql}`] ?? (options.files?.[path] === undefined ? null : []),
  };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** An unsigned JWT with the given payload. */
export const jwt = (payload: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
