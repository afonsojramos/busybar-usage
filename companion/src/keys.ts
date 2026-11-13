import { join } from "node:path";
import { isRecord } from "./feed.ts";
import type { Context } from "./providers/types.ts";

// API keys come from, in order: the provider's environment variables, the companion's config file,
// and CodexBar's config file, so a CodexBar setup works without copying keys.

function configHome(context: Context): string {
  return context.env.XDG_CONFIG_HOME || join(context.home, ".config");
}

/** The companion's config: {"providers": {"<id>": {"apiKey": "..."}}}. */
export function companionConfigPath(context: Context): string {
  return context.env.BUSYBAR_USAGE_CONFIG || join(configHome(context), "busybar-usage", "config.json");
}

async function readJson(context: Context, path: string): Promise<unknown> {
  const text = await context.readFile(path);
  if (text === null || text.trim() === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

export interface ResolvedKey {
  key: string;
  /** Where the key came from. */
  source: "env" | "companion" | "codexbar";
  /** The config entry the key came from, read in the same pass, or null for an environment variable. */
  entry: Record<string, unknown> | null;
}

async function fromCompanionConfig(context: Context, providerId: string): Promise<ResolvedKey | null> {
  const config = await readJson(context, companionConfigPath(context));
  const providers = isRecord(config) ? config.providers : null;
  const entry = isRecord(providers) ? providers[providerId] : null;
  const key = isRecord(entry) ? nonEmpty(entry.apiKey) : null;
  return key && isRecord(entry) ? { key, source: "companion", entry } : null;
}

/** The CodexBar config files in the order CodexBar itself prefers them. */
function codexBarConfigPaths(context: Context): string[] {
  if (context.env.CODEXBAR_CONFIG) return [context.env.CODEXBAR_CONFIG];
  return [join(configHome(context), "codexbar", "config.json"), join(context.home, ".codexbar", "config.json")];
}

async function fromCodexBarConfig(context: Context, providerId: string): Promise<ResolvedKey | null> {
  for (const path of codexBarConfigPaths(context)) {
    const config = await readJson(context, path);
    if (config === null) continue;
    const providers = isRecord(config) && Array.isArray(config.providers) ? config.providers : [];
    const entry = providers.find((provider) => isRecord(provider) && provider.id === providerId);
    if (!isRecord(entry)) return null;
    const direct = nonEmpty(entry.apiKey);
    if (direct) return { key: direct, source: "codexbar", entry };
    // A selected token account, as CodexBar uses for providers with several keys.
    const accounts = isRecord(entry.tokenAccounts) ? entry.tokenAccounts : null;
    const list = accounts && Array.isArray(accounts.accounts) ? accounts.accounts : [];
    const index = typeof accounts?.activeIndex === "number" ? accounts.activeIndex : 0;
    const selected = list[index];
    const token = isRecord(selected) ? nonEmpty(selected.token) : null;
    return token ? { key: token, source: "codexbar", entry } : null;
  }
  return null;
}

/** The API key for a provider with where it came from, or null when none is set anywhere. */
export async function resolveKey(
  context: Context,
  providerId: string,
  envNames: string[],
): Promise<ResolvedKey | null> {
  for (const name of envNames) {
    const value = nonEmpty(context.env[name]);
    if (value) return { key: value, source: "env", entry: null };
  }
  return (await fromCompanionConfig(context, providerId)) ?? (await fromCodexBarConfig(context, providerId));
}

/**
 * A provider's settings entry, such as its region, workspace or base URL: the companion's entry when
 * it has one, otherwise CodexBar's. Empty when neither config has the provider.
 */
export async function providerEntry(context: Context, providerId: string): Promise<Record<string, unknown>> {
  const config = await readJson(context, companionConfigPath(context));
  const providers = isRecord(config) ? config.providers : null;
  const own = isRecord(providers) ? providers[providerId] : null;
  if (isRecord(own)) return own;
  for (const path of codexBarConfigPaths(context)) {
    const codexBar = await readJson(context, path);
    if (codexBar === null) continue;
    const list = isRecord(codexBar) && Array.isArray(codexBar.providers) ? codexBar.providers : [];
    const entry = list.find((provider) => isRecord(provider) && provider.id === providerId);
    return isRecord(entry) ? entry : {};
  }
  return {};
}

/** The API key for a provider, or null when none is set anywhere. */
export async function apiKey(context: Context, providerId: string, envNames: string[]): Promise<string | null> {
  return (await resolveKey(context, providerId, envNames))?.key ?? null;
}
