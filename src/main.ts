import { textWidth } from "@busy-app/busy-lib";
import { device } from "@shared/device";
import manifest from "./appmeta/manifest.json";
import { accountFrame, messageFrame, type Element } from "./frame.ts";
import { markStale, mergeAccounts, parseUsage, type Account } from "./usage.ts";

/** The name the app draws under; the device clears elements by this id. */
const APP = manifest.id;

/** Where the companion writes its feed; the app's private storage. */
const COMPANION_FEED_URL = "http://localhost/api/storage/read?path=/ext/data/usage.json";
/** The hub and the companion both update once a minute. */
const REFRESH_MS = 60_000;
const PAGE_MS = 6_000;
/**
 * The companion sends fresh numbers every minute and keeps a provider's last numbers for up to an
 * hour while it is failing; older ones mean it stopped.
 */
const COMPANION_MAX_AGE_MS = 65 * 60_000;

/** The optional CLIProxyAPI hub; empty when not set. */
let hubUrl = "";
/** From the "uppercase" setting. */
let uppercase = false;
/** Each source's last successful read, so one failing source keeps its last numbers. */
let companionAccounts: Account[] = [];
let hubAccounts: Account[] = [];
let accounts: Account[] = [];
let message = "Loading";
let page = 0;
let stopped = false;

/** What is on screen, by element id, so a redraw sends only what changed. */
let drawn: Record<string, string> = {};
/** The display request in flight, so shutdown can wait for it. */
let drawing: Promise<void> | null = null;
let drawAgain = false;
/** One refresh at a time. The firmware's fetch fails after 5 s without data, so a request cannot hang. */
let refreshing = false;

const measure = (text: string, font: "tiny" | "small") => textWidth(text, font);

const report = (err: unknown) => console.error(`${APP}: ${err instanceof Error ? err.message : String(err)}`);

function frame(): Element[] {
  const style = { measure, uppercase };
  if (accounts.length === 0) return messageFrame(message, style);
  return accountFrame(accounts[page % accounts.length], Math.floor(Date.now() / 1000), style);
}

/** Sends the current page: clears elements it no longer uses and draws the ones that changed. */
async function sendFrame(): Promise<void> {
  const elements = frame();
  const next: Record<string, string> = {};
  const changed: Element[] = [];
  for (const element of elements) {
    const encoded = JSON.stringify(element);
    next[element.id] = encoded;
    if (drawn[element.id] !== encoded) changed.push(element);
  }
  const unused = Object.keys(drawn).filter((id) => !(id in next));
  try {
    if (unused.length > 0) await device.DisplayClear({ application_name: APP, element_ids: unused });
    if (stopped) return;
    if (changed.length > 0) await device.DisplayDraw({ application_name: APP, priority: 50, elements: changed });
    drawn = next;
  } catch (err) {
    // Any of these may still be on screen: keep their ids so they get cleared, but resend them all.
    const unknown: Record<string, string> = {};
    for (const id of Object.keys(drawn)) unknown[id] = "";
    for (const id of Object.keys(next)) unknown[id] = "";
    drawn = unknown;
    throw err;
  }
}

/** Draws the current page. Keeps one display request in flight and coalesces the rest. */
function draw(): void {
  if (stopped) return;
  if (drawing) {
    drawAgain = true;
    return;
  }
  drawing = sendFrame()
    .catch(report)
    .then(() => {
      drawing = null;
      if (drawAgain && !stopped) {
        drawAgain = false;
        draw();
      }
    });
}

/** Reads one feed. Returns null when it cannot be read, an empty list when it has no accounts. */
async function readFeed(url: string): Promise<Account[] | null> {
  try {
    const response = await fetch(url);
    const text = await response.text();
    return response.ok ? parseUsage(text) : null;
  } catch (err) {
    report(err);
    return null;
  }
}

/** Reads the companion's feed and the hub, one after the other. A source that fails keeps its last numbers. */
async function refresh(): Promise<void> {
  if (refreshing || stopped) return;
  refreshing = true;
  try {
    const companion = await readFeed(COMPANION_FEED_URL);
    if (companion !== null) companionAccounts = companion;
    const hub = hubUrl === "" ? null : await readFeed(hubUrl);
    if (hub !== null) hubAccounts = hub;
    accounts = mergeAccounts([markStale(companionAccounts, Date.now(), COMPANION_MAX_AGE_MS), hubAccounts]);
    message = hubUrl !== "" && hub === null ? "Hub offline" : "No usage yet";
  } finally {
    refreshing = false;
  }
  draw();
}

/** Reads the app's settings, which the firmware serves to the running app. */
async function loadSettings(): Promise<void> {
  const response = await fetch(`http://localhost/api/apps/settings?app_id=${APP}`);
  const document: unknown = JSON.parse(await response.text());
  const values = typeof document === "object" && document !== null ? (document as { values?: unknown }).values : null;
  if (typeof values !== "object" || values === null) return;
  const { hub_url, uppercase: upper } = values as { hub_url?: unknown; uppercase?: unknown };
  if (typeof hub_url === "string" && /^https?:\/\/\S+$/.test(hub_url)) hubUrl = hub_url;
  uppercase = upper === true;
}

/**
 * Entry point, called at the end of the file: the device runs this script from top to bottom and starts nothing by itself.
 */
function main(): void {
  draw();
  void loadSettings()
    .catch(report)
    .then(() => refresh())
    .catch(report);

  const refreshTimer = setInterval(() => void refresh().catch(report), REFRESH_MS);
  const nextPage = () => {
    // A single page has nothing to rotate to.
    if (accounts.length < 2) return;
    page += 1;
    draw();
  };
  let pageTimer = setInterval(nextPage, PAGE_MS);

  const unbind = listen("input", (event) => {
    if (stopped) return;
    if (event.key === "encoder") {
      page = Math.max(0, page + event.delta + accounts.length);
      // A page picked with the wheel stays for a full turn before rotation resumes.
      clearInterval(pageTimer);
      pageTimer = setInterval(nextPage, PAGE_MS);
      draw();
    } else if (event.key === "ok" && event.action === "short") {
      void refresh().catch(report);
    } else if (event.key === "back" && event.action === "short") {
      stopped = true;
      clearInterval(refreshTimer);
      clearInterval(pageTimer);
      // Clear only after the draw in flight, so it cannot redraw over the cleared screen.
      void (drawing ?? Promise.resolve()).then(() => device.DisplayClear({ application_name: APP })).catch(report);
      // Not detached from inside the handler itself: with nothing else left the unbind stops the app while this handler is still running.
      setTimeout(unbind, 0);
    }
  });
}

main();
