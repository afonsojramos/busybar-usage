import { browserCookieHeader } from "./browser-cookies.ts";
import { providerEntry } from "./keys.ts";
import type { Context } from "./providers/types.ts";

// A provider that signs in with a web session gets its Cookie header from, in order: its environment
// variables, a `cookieHeader` saved in the companion's or CodexBar's config, and the cookies of a
// browser on this computer for the provider's domains.

export interface CookieOptions {
  /** Domains whose browser cookies belong to this provider, such as ["cursor.com", "www.cursor.com"]. */
  domains: string[];
  /** Environment variables holding a full Cookie header, in CodexBar's order. */
  envNames?: string[];
  /** Cookie names the provider needs; browser cookies without one of them are not used. */
  required?: string[];
}

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** A Cookie header for a provider, or null when no session is available. */
export async function cookieHeader(context: Context, providerId: string, options: CookieOptions): Promise<string | null> {
  for (const name of options.envNames ?? []) {
    const value = nonEmpty(context.env[name]);
    if (value) return value;
  }
  const entry = await providerEntry(context, providerId);
  const saved = nonEmpty(entry.cookieHeader);
  if (saved) return saved;
  // CodexBar's "Off" means the user does not want cookies used for this provider.
  if (entry.cookieSource === "off") return null;
  return browserCookieHeader(context, options.domains, options.required ?? []);
}
