// The usage feed the bar app reads. The CLIProxyAPI hub serves the same shape at GET /usage.

export interface FeedWindow {
  /** Short label shown on the bar, such as "5h" or "7d". */
  name: string;
  minutes: number | null;
  /** Null for a window that has no limit to measure against, such as a prepaid balance. */
  used_percent: number | null;
  /** Unix seconds. */
  resets_at: number | null;
  /** Text shown instead of a bar, such as "$12.40", when used_percent is null. */
  value?: string;
}

export interface FeedAccount {
  provider: string;
  /** How the bar names the provider, such as "z.ai"; the bar capitalizes `provider` without it. */
  provider_name?: string;
  /** A short, non-identifying label, such as the email domain's first label. */
  account: string;
  blocked: boolean;
  /** When these numbers were measured, ISO 8601. */
  observed_at: string;
  windows: FeedWindow[];
  /** Why there are no numbers, such as "sign in" when the provider's login expired. */
  error?: string;
}

export interface Feed {
  generated_at: string;
  accounts: FeedAccount[];
}

/** "5h" for 300 minutes, "7d" for 10080. */
export function windowName(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Names an account by its email domain's first label ("gmail", "yld"), as the hub does, so the
 * address stays off the bar and the same login gets the same name from either source.
 */
export function accountLabel(email: string | null | undefined): string {
  const domain = email?.split("@")[1];
  const label = (domain?.split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return label || "default";
}

/** A window from a percentage and a reset time; past resets count as zero, as on the hub. */
export function feedWindow(
  minutes: number | null,
  usedPercent: number,
  resetsAt: number | null,
  nowSeconds: number,
  name = minutes === null ? "" : windowName(minutes),
): FeedWindow {
  const used = resetsAt !== null && resetsAt <= nowSeconds ? 0 : Math.max(0, Math.round(usedPercent));
  return { name, minutes, used_percent: used, resets_at: resetsAt };
}

/** A window with a value but no limit, such as a balance; the bar shows the text without a bar. */
export function valueWindow(name: string, value: string, resetsAt: number | null = null): FeedWindow {
  return { name, minutes: null, used_percent: null, resets_at: resetsAt, value };
}

/** Parses an ISO 8601 date to Unix seconds, or null. */
export function isoToSeconds(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
