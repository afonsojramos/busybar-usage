import assert from "node:assert/strict";
import { test } from "node:test";
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

test("with the bar's fonts, uppercase CLAUDE and COPILOT fit and the columns do not overlap", () => {
  registerFontMaps(small);
  registerFontMaps(tiny);
  const frameOf = (provider: string) =>
    accountFrame(
      account({ provider, account: "gmail", windows: [{ name: "30d", usedPercent: 50, resetsAt: null, value: null }] }),
      1000,
      { measure: textWidth, uppercase: true },
    );
  assert.equal(texts(frameOf("copilot"))[0], "COPILOT");
  const frame = frameOf("claude");
  assert.deepEqual(texts(frame), ["CLAUDE", "GMAIL", "30D", "50%"]);
  type Placed = { id: string; type: string; x?: number; width?: number; text?: string; font?: string };
  const at = (id: string) => frame.find((element) => element.id === id) as Placed;
  const left = (id: string) => at(id).x ?? 0;
  const right = (id: string) => {
    const element = at(id);
    const width = element.type === "text" ? textWidth(element.text ?? "", element.font as "tiny" | "small") : (element.width ?? 0);
    return left(id) + width;
  };
  assert.ok(right("provider") <= left("w0_name"));
  assert.ok(right("w0_name") <= left("w0_box"));
  // The value is right-aligned to the screen's edge and can be as wide as "100%".
  assert.ok(right("w0_box") <= 72 - textWidth("100%", "small"));
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
