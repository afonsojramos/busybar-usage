import type { Context } from "../src/providers/types.ts";

export const NOW = 1_794_580_000;

export interface Call {
  url: string;
  headers: Record<string, string>;
}

/** A context with in-memory files and Keychain items, and a fetch that answers from a queue. */
export function fakeContext(options: {
  files?: Record<string, string>;
  keychain?: Record<string, string>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  responses?: Response[];
}): Context & { calls: Call[] } {
  const calls: Call[] = [];
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
    readKeychain: async (service) => options.keychain?.[service] ?? null,
  };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** An unsigned JWT with the given payload. */
export const jwt = (payload: Record<string, unknown>) =>
  ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "sig"].join(".");
