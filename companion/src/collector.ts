import type { Feed, FeedAccount } from "./feed.ts";
import { HttpError, NotConfigured, RateLimited, type Context, type Provider } from "./providers/types.ts";

/** After an unexpected failure, wait this long before asking that provider again. */
const ERROR_BACKOFF_SECONDS = 300;
/** Last good numbers are kept through failures for this long, then dropped. */
const KEEP_SECONDS = 3600;

interface State {
  accounts: FeedAccount[];
  /** When the accounts were fetched, Unix seconds. */
  fetchedAt: number;
  /** Do not ask the provider before this, Unix seconds. */
  retryAt: number;
  /** The last logged outcome, so each change is logged once. */
  status: string;
}

export type Log = (message: string) => void;

/** Fetches every provider, keeping each one's last good numbers through rate limits and failures. */
export class Collector {
  private readonly states = new Map<string, State>();
  private readonly providers: Provider[];
  private readonly context: Context;
  private readonly log: Log;

  constructor(providers: Provider[], context: Context, log: Log) {
    this.providers = providers;
    this.context = context;
    this.log = log;
  }

  private report(provider: Provider, state: State, status: string, message: string): void {
    if (state.status === status) return;
    state.status = status;
    this.log(`${provider.name}: ${message}`);
  }

  private async update(provider: Provider): Promise<void> {
    const now = this.context.now();
    let state = this.states.get(provider.id);
    if (!state) {
      state = { accounts: [], fetchedAt: 0, retryAt: 0, status: "" };
      this.states.set(provider.id, state);
    }
    if (state.accounts.length > 0 && now - state.fetchedAt > KEEP_SECONDS) state.accounts = [];
    if (now < state.retryAt) return;
    if (provider.minIntervalSeconds && state.fetchedAt > 0 && now - state.fetchedAt < provider.minIntervalSeconds) return;
    try {
      state.accounts = await provider.fetch(this.context);
      state.fetchedAt = now;
      const errors = state.accounts.filter((account) => account.error).map((account) => account.error);
      this.report(provider, state, errors.length ? `error:${errors.join()}` : "ok", errors.length ? errors.join(", ") : "updated");
    } catch (error) {
      if (error instanceof NotConfigured) {
        state.accounts = [];
        this.report(provider, state, "skipped", "not set up on this machine, skipping");
      } else if (error instanceof RateLimited) {
        state.retryAt = error.until;
        this.report(provider, state, "rate-limited", "rate-limited, keeping the last numbers");
      } else {
        state.retryAt = now + ERROR_BACKOFF_SECONDS;
        // Only our own errors are safe to log: a fetch error can quote a header that holds a key.
        const message =
          error instanceof HttpError ? error.message : `request failed (${error instanceof Error ? error.name : "error"})`;
        this.report(provider, state, `failed:${message}`, `${message}; keeping the last numbers`);
      }
    }
  }

  async collect(): Promise<Feed> {
    await Promise.all(this.providers.map((provider) => this.update(provider)));
    return {
      generated_at: new Date(this.context.now() * 1000).toISOString(),
      accounts: this.providers.flatMap((provider) =>
        (this.states.get(provider.id)?.accounts ?? []).map((account) => ({ ...account, provider_name: provider.name })),
      ),
    };
  }
}
