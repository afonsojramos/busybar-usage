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

async function fromCompanionConfig(context: Context, providerId: string): Promise<string | null> {
  const config = await readJson(context, companionConfigPath(context));
  const providers = isRecord(config) ? config.providers : null;
  const entry = isRecord(providers) ? providers[providerId] : null;
  return isRecord(entry) ? nonEmpty(entry.apiKey) : null;
}

/** The CodexBar config files in the order CodexBar itself prefers them. */
function codexBarConfigPaths(context: Context): string[] {
  if (context.env.CODEXBAR_CONFIG) return [context.env.CODEXBAR_CONFIG];
  return [join(configHome(context), "codexbar", "config.json"), join(context.home, ".codexbar", "config.json")];
}

async function fromCodexBarConfig(context: Context, providerId: string): Promise<string | null> {
  for (const path of codexBarConfigPaths(context)) {
    const config = await readJson(context, path);
    if (config === null) continue;
    const providers = isRecord(config) && Array.isArray(config.providers) ? config.providers : [];
    const entry = providers.find((provider) => isRecord(provider) && provider.id === providerId);
    if (!isRecord(entry)) return null;
    const direct = nonEmpty(entry.apiKey);
    if (direct) return direct;
    // A selected token account, as CodexBar uses for providers with several keys.
    const accounts = isRecord(entry.tokenAccounts) ? entry.tokenAccounts : null;
    const list = accounts && Array.isArray(accounts.accounts) ? accounts.accounts : [];
    const index = typeof accounts?.activeIndex === "number" ? accounts.activeIndex : 0;
    const selected = list[index];
    return isRecord(selected) ? nonEmpty(selected.token) : null;
  }
  return null;
}

/** The API key for a provider, or null when none is set anywhere. */
export async function apiKey(context: Context, providerId: string, envNames: string[]): Promise<string | null> {
  for (const name of envNames) {
    const value = nonEmpty(context.env[name]);
    if (value) return value;
  }
  return (await fromCompanionConfig(context, providerId)) ?? (await fromCodexBarConfig(context, providerId));
}
