import { type ChildProcess, execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context, RunOptions, RunResult, SqliteValue } from "./providers/types.ts";

const MAX_OUTPUT = 4 * 1024 * 1024;

function readKeychain(service: string, account?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
    // The value goes to this process only; a missing item or a declined prompt reads as "not set up".
    execFile("/usr/bin/security", args, { timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) =>
      resolve(error ? null : stdout.trimEnd() || null),
    );
  });
}

/** Children still running, so a timeout or the companion's exit can stop their whole process group. */
const running = new Set<ChildProcess>();

function killGroup(child: ChildProcess): void {
  try {
    // A negative pid signals the group, which also reaches anything the CLI started.
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

process.once("exit", () => {
  for (const child of running) killGroup(child);
});

function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      // Its own process group, so a timeout can stop descendants that keep the pipes open.
      detached: true,
    });
    running.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult | null) => {
      running.delete(child);
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killGroup(child);
      // Settle now: a descendant that ignored the signal must not hold the result open.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish({ code: null, stdout, stderr });
    }, options.timeoutMs ?? 30_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? null : { code: null, stdout, stderr }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input ?? "");
  });
}

async function querySqlite(path: string, sql: string, params: SqliteValue[] = []): Promise<Record<string, unknown>[] | null> {
  const dir = await mkdtemp(join(tmpdir(), "busybar-usage-"));
  try {
    const copy = join(dir, basename(path));
    try {
      await copyFile(path, copy);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    // Recent writes may still sit in the write-ahead log beside the database.
    for (const suffix of ["-wal", "-shm"]) await copyFile(path + suffix, copy + suffix).catch(() => {});
    const database = new DatabaseSync(copy, { readOnly: true });
    try {
      return database.prepare(sql).all(...params).map((row) => ({ ...row }));
    } finally {
      database.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function orNullWhenMissing<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

export function systemContext(): Context {
  return {
    env: process.env,
    home: homedir(),
    platform: process.platform,
    now: () => Math.floor(Date.now() / 1000),
    fetch: globalThis.fetch,
    readFile: (path) => orNullWhenMissing(() => readFile(path, "utf8")),
    readFileBytes: (path) => orNullWhenMissing(async () => new Uint8Array(await readFile(path))),
    listDir: (path) => orNullWhenMissing(() => readdir(path)),
    readKeychain: (service, account) =>
      process.platform === "darwin" ? readKeychain(service, account) : Promise.resolve(null),
    run,
    querySqlite,
  };
}
