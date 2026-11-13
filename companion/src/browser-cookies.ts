import type { Context } from "./providers/types.ts";

/**
 * A Cookie header from a browser on this computer for the given domains, or null when none is
 * signed in or the browser's cookie store cannot be read.
 */
export async function browserCookieHeader(_context: Context, _domains: string[], _required: string[]): Promise<string | null> {
  return null;
}
