import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { registerFontMaps, textWidth } from "@busy-app/busy-lib";
import { small, tiny } from "@busy-app/busy-lib/fonts";
import { accountFrame } from "../src/frame.ts";

/** About four pixels a character, close to the tiny font. */
const measure = (text: string) => text.length * 4;
const style = { measure, uppercase: false };
import { formatRemaining, markStale, mergeAccounts, parseUsage, type Account } from "../src/usage.ts";

const feed = (accounts: unknown[]) => JSON.stringify({ generated_at: "2026-11-13T14:00:00Z", accounts });

const hubAccount = {
  provider: "claude",
  account: "yld",
  blocked: false,
  observed_at: "2026-11-13T14:04:37.813996165Z",
  windows: [{ name: "5h", minutes: 300, used_percent: 16, resets_at: 1794591000 }],
};

test("parses a feed and drops entries it cannot read", () => {
  const accounts = parseUsage(feed([hubAccount, { provider: 1 }, { ...hubAccount, windows: [{ name: "7d" }] }]));
  assert.equal(accounts?.length, 2);
  assert.equal(accounts?.[0].windows[0].usedPercent, 16);
  assert.equal(accounts?.[1].windows.length, 0);
  assert.equal(parseUsage("not json"), null);
  assert.equal(parseUsage("{}"), null);
});

test("keeps a short error and the measurement time", () => {
  const [account] = parseUsage(feed([{ ...hubAccount, windows: [], error: "sign in", observed_at: "2026-11-13T14:00:00Z" }])) ?? [];
  assert.equal(account.error, "sign in");
  assert.equal(account.observedAt, Date.parse("2026-11-13T14:00:00Z"));
});

test("merging prefers the newer measurement of the same account", () => {
  const older = parseUsage(feed([{ ...hubAccount, observed_at: "2026-11-13T13:00:00Z" }])) ?? [];
  const newer = parseUsage(feed([{ ...hubAccount, observed_at: "2026-11-13T14:00:00Z", windows: [] }, { ...hubAccount, provider: "codex" }])) ?? [];
  const merged = mergeAccounts([older, newer]);
  assert.deepEqual(merged.map((a) => a.provider), ["claude", "codex"]);
  assert.equal(merged[0].windows.length, 0);
});

test("numbers older than the limit are marked stale", () => {
  const accounts = parseUsage(feed([hubAccount, { ...hubAccount, provider: "codex", observed_at: undefined }])) ?? [];
  const observed = Date.parse(hubAccount.observed_at);
  assert.deepEqual(markStale(accounts, observed + 1000, 5000).map((a) => a.error), [null, null]);
  const marked = markStale(accounts, observed + 10_000, 5000);
  assert.deepEqual(marked.map((a) => a.error), ["stale", null]);
  assert.equal(marked[0].windows.length, 0);
});

test("formats the time to a reset", () => {
  assert.equal(formatRemaining(1000 + 2 * 86400 + 5, 1000), "2d");
  assert.equal(formatRemaining(1000 + 5 * 3600, 1000), "5h");
  assert.equal(formatRemaining(1000 + 61, 1000), "2m");
});

const account = (overrides: Partial<Account>): Account => ({
  provider: "claude",
  providerName: null,
  account: "yld",
  blocked: false,
  windows: [],
  observedAt: 0,
  error: null,
  ...overrides,
});

const texts = (elements: ReturnType<typeof accountFrame>) =>
  elements.flatMap((element) => (element.type === "text" ? [element.text] : []));

test("a full window shows the time to its reset instead of 100%", () => {
  const frame = accountFrame(account({ windows: [{ name: "7d", usedPercent: 100, resetsAt: 1000 + 3 * 3600, value: null }] }), 1000, style);
  assert.deepEqual(texts(frame), ["Claude", "yld", "7d", "3h"]);
});

test("a window without a percentage shows its value instead of a bar", () => {
  const [parsed] = parseUsage(feed([{ ...hubAccount, windows: [{ name: "bal", minutes: null, used_percent: null, resets_at: null, value: "$12.40" }] }])) ?? [];
  assert.equal(parsed.windows[0].value, "$12.40");
  const frame = accountFrame(parsed, 1000, style);
  assert.deepEqual(texts(frame), ["Claude", "yld", "bal", "$12.40"]);
  assert.equal(frame.filter((element) => element.type === "rectangle").length, 0);
});

test("an error replaces the windows", () => {
  const frame = accountFrame(account({ error: "sign in", windows: [{ name: "5h", usedPercent: 5, resetsAt: null, value: null }] }), 1000, style);
  assert.deepEqual(texts(frame), ["Claude", "yld", "sign in"]);
});

test("the feed's provider name wins over the id", () => {
  const [parsed] = parseUsage(feed([{ ...hubAccount, provider: "zai", provider_name: "z.ai" }])) ?? [];
  assert.equal(texts(accountFrame(parsed, 1000, style))[0], "z.ai");
});

test("long names are cut to the column", () => {
  const frame = accountFrame(account({ provider: "antigravity", account: "my_company" }), 1000, style);
  assert.deepEqual(texts(frame).slice(0, 2), ["Antigr", "my_com"]);
});

test("uppercase draws every label in capitals and fits the capitals", () => {
  const frame = accountFrame(
    account({ provider: "claude", account: "gmail", windows: [{ name: "7d", usedPercent: 100, resetsAt: 1000 + 2 * 86400, value: null }] }),
    1000,
    { measure, uppercase: true },
  );
  assert.deepEqual(texts(frame), ["CLAUDE", "GMAIL", "7D", "2D"]);
});

registerFontMaps(small);
registerFontMaps(tiny);

type Placed = { id: string; type: string; x?: number; width?: number; text?: string; font?: string; align?: string };

/** The first and last columns an element lights; a text's advance ends in one blank column. */
function ink(element: Placed): [number, number] {
  const x = element.x ?? 0;
  if (element.type !== "text") return [x, x + (element.width ?? 0) - 1];
  const advance = textWidth(element.text ?? "", element.font as "tiny" | "small");
  const left = element.align === "top_right" ? x - advance : x;
  return [left, left + advance - 2];
}

/** Fails when an element runs off the screen or touches its neighbour on the same row. */
function assertFits(frame: ReturnType<typeof accountFrame>, what: string): void {
  const at = (id: string) => (frame as Placed[]).find((element) => element.id === id);
  for (const element of frame as Placed[]) assert.ok(ink(element)[1] <= 71, `${what}: ${element.id} runs off the screen`);
  for (const [row, label] of [[0, "provider"], [1, "account"]] as const) {
    const line = [label, `w${row}_name`, `w${row}_box`, `w${row}_value`].flatMap((id) => at(id) ?? []);
    for (let i = 1; i < line.length; i++) {
      assert.ok(ink(line[i])[0] - ink(line[i - 1])[1] >= 2, `${what}: ${line[i - 1].id} touches ${line[i].id}`);
    }
  }
}

const percentWindow = (name: string, usedPercent: number) => ({ name, usedPercent, resetsAt: null, value: null });
const valueOnly = (name: string, value: string) => ({ name, usedPercent: null, resetsAt: null, value });

test("with the bar's fonts, nothing touches or runs off the screen, in either case", () => {
  const pages = {
    claude: account({ provider: "claude", account: "gmail", windows: [percentWindow("5h", 38), percentWindow("7d", 74)] }),
    "copilot windows": account({ provider: "copilot", account: "gmail", windows: [percentWindow("Premium", 63), percentWindow("Chat", 12)] }),
    "a wide window name": account({ provider: "gemini", account: "work", windows: [percentWindow("Monthly", 50), percentWindow("mem", 9)] }),
    "copilot credits": account({ provider: "copilot", account: "gmail", windows: [valueOnly("Credits", "150.5 cr")] }),
    "venice balance": account({ provider: "venice", account: "gmail", windows: [valueOnly("USD", "$1234.56")] }),
    "copilot error": account({ provider: "copilot", account: "gmail", error: "plan ended" }),
    "claude error": account({ provider: "claude", account: "gmail", error: "no access" }),
    "no data": account({ provider: "copilot", account: "gmail" }),
    "a full window without a reset time": account({ windows: [percentWindow("5h", 100), percentWindow("7d", 20)] }),
    "a reset 400 days away": account({ windows: [{ name: "30d", usedPercent: 100, resetsAt: 1000 + 400 * 86400, value: null }] }),
    "a long credit balance": account({ provider: "openrouter", account: "gmail", windows: [valueOnly("Credits", "1234567.8 cr")] }),
    "a long hour balance": account({ provider: "openrouter", account: "gmail", windows: [valueOnly("Hours", "12,345.67 hc")] }),
  };
  for (const uppercase of [false, true]) {
    for (const [what, page] of Object.entries(pages)) {
      assertFits(accountFrame(page, 1000, { measure: textWidth, uppercase }), `${what}${uppercase ? ", uppercase" : ""}`);
    }
  }
});

test("with the bar's fonts, uppercase CLAUDE and COPILOT fit", () => {
  const frameOf = (provider: string) =>
    accountFrame(account({ provider, account: "gmail", windows: [percentWindow("30d", 50)] }), 1000, { measure: textWidth, uppercase: true });
  assert.equal(texts(frameOf("copilot"))[0], "COPILOT");
  assert.deepEqual(texts(frameOf("claude")), ["CLAUDE", "GMAIL", "30D", "50%"]);
});

test("ids stay unique within a frame", () => {
  const frame = accountFrame(
    account({ windows: [{ name: "5h", usedPercent: 50, resetsAt: null, value: null }, { name: "7d", usedPercent: 95, resetsAt: null, value: null }] }),
    1000,
    style,
  );
  const ids = frame.map((element) => element.id);
  assert.equal(new Set(ids).size, ids.length);
});
