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
  /** A generic password from the macOS login Keychain, or null when there is none. */
  readKeychain(service: string): Promise<string | null>;
}

export interface Provider {
  id: string;
  name: string;
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

/** Seconds from a Retry-After header, or a default. */
export function retryAfterSeconds(headers: Headers, fallback: number): number {
  const value = headers.get("retry-after");
  if (!value) return fallback;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.round((date - Date.now()) / 1000)) : fallback;
}
