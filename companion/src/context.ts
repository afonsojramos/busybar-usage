import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { Context } from "./providers/types.ts";

function readKeychain(service: string): Promise<string | null> {
  return new Promise((resolve) => {
    // The value goes to this process only; a missing item or a declined prompt reads as "not set up".
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout.trimEnd() || null),
    );
  });
}

export function systemContext(): Context {
  return {
    env: process.env,
    home: homedir(),
    platform: process.platform,
    now: () => Math.floor(Date.now() / 1000),
    fetch: globalThis.fetch,
    async readFile(path) {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    readKeychain: (service) => (process.platform === "darwin" ? readKeychain(service) : Promise.resolve(null)),
  };
}
