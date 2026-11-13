import type { Feed, FeedAccount } from "./feed.ts";
import { HttpError, NotConfigured, RateLimited, type Context, type Provider } from "./providers/types.ts";

/** After an unexpected failure, wait this long before asking that provider again. */
const ERROR_BACKOFF_SECONDS = 300;
/** Last good numbers are kept through failures for this long, then dropped. */
const KEEP_SECONDS = 3600;
/** An attempt still running after this is abandoned, so a stuck provider gets another try. */
const ABANDON_SECONDS = 600;
/** How long one collection waits for providers before sending what it has. */
const DEFAULT_WAIT_MS = 45_000;

interface State {
  accounts: FeedAccount[];
  /** When the accounts were fetched, Unix seconds. */
  fetchedAt: number;
  /** When the last attempt started, Unix seconds, for minIntervalSeconds. */
  attemptedAt: number;
  /** Do not ask the provider before this, Unix seconds. */
  retryAt: number;
  /** The attempt in flight; a newer attempt replaces it, and an abandoned one's result is ignored. */
  attempt: { id: number; done: Promise<void> } | null;
  /** The last logged outcome, so each change is logged once. */
  status: string;
}

export type Log = (message: string) => void;

export interface CollectorOptions {
  /** How long collect() waits for slow providers; they finish in the background. Infinity waits for all. */
  waitMs?: number;
}

/**
 * Fetches every provider, keeping each one's last good numbers through rate limits and failures.
 * A slow provider does not hold up the others: collect() returns after waitMs with what it has,
 * and the slow one's numbers arrive with a later collection.
 */
export class Collector {
  private readonly states = new Map<string, State>();
  private readonly providers: Provider[];
  private readonly context: Context;
  private readonly log: Log;
  private readonly waitMs: number;
  private attempts = 0;

  constructor(providers: Provider[], context: Context, log: Log, options: CollectorOptions = {}) {
    this.providers = providers;
    this.context = context;
    this.log = log;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  }

  private report(provider: Provider, state: State, status: string, message: string): void {
    if (state.status === status) return;
    state.status = status;
    this.log(`${provider.name}: ${message}`);
  }

  private stateFor(provider: Provider): State {
    let state = this.states.get(provider.id);
    if (!state) {
      state = { accounts: [], fetchedAt: 0, attemptedAt: 0, retryAt: 0, attempt: null, status: "" };
      this.states.set(provider.id, state);
    }
    return state;
  }

  /** Starts an attempt when one is due, and returns the attempt in flight, if any. */
  private update(provider: Provider): Promise<void> | null {
    const now = this.context.now();
    const state = this.stateFor(provider);
    if (state.accounts.length > 0 && now - state.fetchedAt > KEEP_SECONDS) state.accounts = [];
    if (state.attempt) {
      if (now - state.attemptedAt < ABANDON_SECONDS) return state.attempt.done;
      // Its result is ignored if it ever arrives; the checks below decide when to try again.
      state.attempt = null;
      this.report(provider, state, "abandoned", "still running after 10 minutes; ignoring it");
    }
    if (now < state.retryAt) return null;
    const minimum = provider.minIntervalSeconds ?? 0;
    if (minimum > 0 && state.attemptedAt > 0 && now - state.attemptedAt < minimum) return null;

    const id = ++this.attempts;
    state.attemptedAt = now;
    const current = () => state.attempt?.id === id;
    const done = (async () => {
      try {
        const accounts = await provider.fetch(this.context);
        if (!current()) return;
        state.accounts = accounts;
        state.fetchedAt = this.context.now();
        const errors = accounts.filter((account) => account.error).map((account) => account.error);
        this.report(provider, state, errors.length ? `error:${errors.join()}` : "ok", errors.length ? errors.join(", ") : "updated");
      } catch (error) {
        if (!current()) return;
        if (error instanceof NotConfigured) {
          state.accounts = [];
          this.report(provider, state, "skipped", "not set up on this machine, skipping");
        } else if (error instanceof RateLimited) {
          state.retryAt = error.until;
          this.report(provider, state, "rate-limited", "rate-limited, keeping the last numbers");
        } else {
          state.retryAt = this.context.now() + ERROR_BACKOFF_SECONDS;
          // Only our own errors are safe to log: a fetch error can quote a header that holds a key.
          const message =
            error instanceof HttpError ? error.message : `request failed (${error instanceof Error ? error.name : "error"})`;
          this.report(provider, state, `failed:${message}`, `${message}; keeping the last numbers`);
        }
      } finally {
        if (current()) state.attempt = null;
      }
    })();
    state.attempt = { id, done };
    return done;
  }

  async collect(): Promise<Feed> {
    const pending = Promise.all(this.providers.map((provider) => this.update(provider)).filter((done) => done !== null));
    if (Number.isFinite(this.waitMs)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        pending,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, this.waitMs);
        }),
      ]);
      clearTimeout(timer);
    } else {
      await pending;
    }
    return {
      generated_at: new Date(this.context.now() * 1000).toISOString(),
      accounts: this.providers.flatMap((provider) =>
        (this.states.get(provider.id)?.accounts ?? []).map((account) => ({ ...account, provider_name: provider.name })),
      ),
    };
  }
}
