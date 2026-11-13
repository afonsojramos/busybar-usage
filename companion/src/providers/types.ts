import type { FeedAccount } from "../feed.ts";

/** What a provider may use. Tests replace each part. */
export interface Context {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** Unix seconds. */
  now(): number;
  fetch: typeof fetch;
  /** File contents, or null when the file does not exist. */
  readFile(path: string): Promise<string | null>;
  /** Raw file contents for binary formats, or null when the file does not exist. */
  readFileBytes(path: string): Promise<Uint8Array | null>;
  /** Entry names in a directory, or null when it does not exist. */
  listDir(path: string): Promise<string[] | null>;
  /**
   * A generic password from the macOS login Keychain, or null when there is none or access is
   * declined. Pass an account to pick one item when a service has several.
   */
  readKeychain(service: string, account?: string): Promise<string | null>;
  /**
   * Runs a program without a shell and waits for it, or returns null when it is not installed.
   * Only for a provider's own CLI reporting usage; never for anything that changes state.
   */
  run(command: string, args: string[], options?: RunOptions): Promise<RunResult | null>;
  /**
   * Rows from a read-only query on a copy of a SQLite database, so an app holding it open is not
   * disturbed. Null when the file does not exist.
   */
  querySqlite(path: string, sql: string, params?: SqliteValue[]): Promise<Record<string, unknown>[] | null>;
}

export type SqliteValue = string | number | bigint | null | Uint8Array;

export interface RunOptions {
  /** Default 30 s; the process is killed after it. */
  timeoutMs?: number;
  /** Written to the program's standard input, which is closed after it. */
  input?: string;
  cwd?: string;
  /** Added to the companion's environment. */
  env?: Record<string, string>;
}

export interface RunResult {
  /** Null when the process was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Provider {
  id: string;
  name: string;
  /**
   * Ask at most this often, reusing the last numbers in between. For providers whose only usage
   * check is a billable request, such as a one-token chat completion.
   */
  minIntervalSeconds?: number;
  /**
   * Returns this provider's accounts. Throws NotConfigured when the machine has no login or key
   * for it, so the companion can skip it quietly.
   */
  fetch(context: Context): Promise<FeedAccount[]>;
}

/** The machine has no login or key for this provider. */
export class NotConfigured extends Error {
  constructor(provider: string) {
    super(`${provider} is not set up on this machine`);
    this.name = "NotConfigured";
  }
}

/** The provider asked us to wait. */
export class RateLimited extends Error {
  /** Unix seconds before which the provider should not be asked again. */
  readonly until: number;
  constructor(provider: string, until: number) {
    super(`${provider} rate-limited the usage request`);
    this.name = "RateLimited";
    this.until = until;
  }
}

/** A failed HTTP request, with the status but never the body, which may echo credentials. */
export class HttpError extends Error {
  readonly status: number;
  constructor(provider: string, status: number) {
    super(`${provider} usage request failed with HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * Whether an endpoint override may receive this provider's credential: HTTPS on one of the
 * provider's own hosts, so a stray override cannot send a key elsewhere.
 */
export function isProviderHost(url: URL, hosts: readonly string[]): boolean {
  return url.protocol === "https:" && hosts.includes(url.hostname) && url.port === "";
}

/** Seconds from a Retry-After header, or a default. */
export function retryAfterSeconds(headers: Headers, fallback: number): number {
  const value = headers.get("retry-after");
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.round((date - Date.now()) / 1000)) : fallback;
}
