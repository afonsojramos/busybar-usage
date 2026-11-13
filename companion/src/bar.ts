import { BusyBar } from "@busy-app/busy-lib";
import type { Feed } from "./feed.ts";

/** Must match the id in src/appmeta/manifest.json; a test checks it. */
export const APP_ID = "app.afonsojramos.usage";
/** The app's private storage, which the app reads as /ext/data. */
export const FEED_PATH = `/ext/apps_data/js_apps/${APP_ID}/usage.json`;

export interface BarOptions {
  /** IP address, host name or URL. Over USB the bar is 10.0.4.20. */
  host: string;
  /** The bar's HTTP access password, when one is set. */
  password?: string;
}

/** Writes the feed where the app reads it. */
export async function pushFeed(feed: Feed, options: BarOptions): Promise<void> {
  const bar = new BusyBar({ addr: options.host, HTTPAccessPassword: options.password, timeout: 10_000 });
  try {
    await bar.StorageWrite({ path: FEED_PATH, file: Buffer.from(JSON.stringify(feed)) });
  } catch (error) {
    // Node's fetch errors can quote a header value, and the password travels in one.
    if (error instanceof TypeError) throw new TypeError("fetch failed");
    throw error;
  }
}
