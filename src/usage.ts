/** One rate-limit window of an account, such as Claude's 5-hour window. */
export interface UsageWindow {
  /** Short name from the hub, such as "5h" or "7d". */
  name: string;
  usedPercent: number;
  /** Unix seconds, or null when the hub does not know. */
  resetsAt: number | null;
}

export interface Account {
  provider: string;
  account: string;
  blocked: boolean;
  windows: UsageWindow[];
  /** Unix milliseconds when the numbers were measured, or 0 when unknown. */
  observedAt: number;
  /** Why there are no numbers, such as "sign in". */
  error: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function parseWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value)) return null;
  const { name, used_percent, resets_at } = value;
  if (typeof name !== "string" || !isFiniteNumber(used_percent)) return null;
  return {
    name,
    usedPercent: Math.max(0, used_percent),
    resetsAt: isFiniteNumber(resets_at) ? resets_at : null,
  };
}

function parseAccount(value: unknown): Account | null {
  if (!isRecord(value)) return null;
  const { provider, account, blocked, windows, observed_at, error } = value;
  if (typeof provider !== "string" || typeof account !== "string" || !Array.isArray(windows)) {
    return null;
  }
  const parsed: UsageWindow[] = [];
  for (const window of windows) {
    const item = parseWindow(window);
    if (item) parsed.push(item);
  }
  const observedAt = typeof observed_at === "string" ? Date.parse(observed_at) : NaN;
  return {
    provider,
    account,
    blocked: blocked === true,
    windows: parsed,
    observedAt: Number.isFinite(observedAt) ? observedAt : 0,
    // The display fits about ten tiny characters here.
    error: typeof error === "string" && error !== "" ? error.slice(0, 10) : null,
  };
}

/** Parses a usage feed (the hub's GET /usage or the companion's file), dropping entries it cannot read. Returns null if the feed itself is unusable. */
export function parseUsage(text: string): Account[] | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(document) || !Array.isArray(document.accounts)) return null;
  const accounts: Account[] = [];
  for (const entry of document.accounts) {
    const account = parseAccount(entry);
    if (account) accounts.push(account);
  }
  return accounts;
}

/**
 * Combines accounts from several sources. When two report the same provider and account, such as
 * the hub and the companion, the more recent measurement wins.
 */
export function mergeAccounts(lists: Account[][]): Account[] {
  const byKey: Record<string, Account> = {};
  const keys: string[] = [];
  for (const list of lists) {
    for (const account of list) {
      const key = `${account.provider}/${account.account}`;
      const current = byKey[key];
      if (!current) keys.push(key);
      if (!current || account.observedAt > current.observedAt) byKey[key] = account;
    }
  }
  return keys.sort().map((key) => byKey[key]);
}

/**
 * Marks accounts whose numbers are older than maxAgeMs as "stale", so a companion that stopped
 * running is not shown as current. Accounts with no measurement time are left alone.
 */
export function markStale(accounts: Account[], nowMs: number, maxAgeMs: number): Account[] {
  return accounts.map((account) =>
    account.observedAt > 0 && nowMs - account.observedAt > maxAgeMs
      ? {
          provider: account.provider,
          account: account.account,
          blocked: account.blocked,
          windows: [],
          observedAt: account.observedAt,
          error: "stale",
        }
      : account,
  );
}

/** Applies resets the hub has not seen yet: a window past its reset time starts again from zero. */
export function currentPercent(window: UsageWindow, nowSeconds: number): number {
  if (window.resetsAt !== null && window.resetsAt <= nowSeconds) return 0;
  return window.usedPercent;
}

/** Time until a reset in the largest whole unit: "2d", "5h", "40m". */
export function formatRemaining(resetsAt: number, nowSeconds: number): string {
  const seconds = Math.max(0, resetsAt - nowSeconds);
  if (seconds >= 86400) return `${Math.floor(seconds / 86400)}d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.max(1, Math.ceil(seconds / 60))}m`;
}
