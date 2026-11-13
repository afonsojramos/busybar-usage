import assert from "node:assert/strict";
import { test } from "node:test";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { cursor } from "../src/providers/cursor.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, jwt, NOW } from "./helpers.ts";

// Shape from CodexBar CursorStatusProbeTests, with future billing dates.
const summary = { billingCycleStart: "2026-11-01T00:00:00Z", billingCycleEnd: "2026-12-01T00:00:00Z", membershipType: "pro",
  individualUsage: { plan: { enabled: true, used: 1500, limit: 5000, totalPercentUsed: 30 }, onDemand: { enabled: true, used: 500, limit: 10000 } } };
const config = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { cursor: { cookieHeader: "WorkosCursorSessionToken=fake-session" } } }) };
const optional = () => [json({ email: "user@example.com" }), json({})];
test("Cursor maps CodexBar usage-summary and optional account", async () => {
  const context = fakeContext({ files: config, responses: [json(summary), ...optional()] });
  const [account] = await cursor.fetch(context);
  assert.equal(account.account, "example");
  assert.deepEqual(account.windows.map(w => [w.name, w.used_percent]), [["30d", 30], ["extra", 5]]);
  assert.equal(context.calls[0].url, "https://cursor.com/api/usage-summary");
  assert.equal(context.calls[0].headers.cookie, "WorkosCursorSessionToken=fake-session");
});
test("Cursor missing session", async () => { await assert.rejects(cursor.fetch(fakeContext({})), NotConfigured); });
for (const status of [401, 403]) test(`Cursor ${status} signs in`, async () => {
  const [account] = await cursor.fetch(fakeContext({ files: config, responses: [json({}, status)] }));
  assert.equal(account.error, "sign in");
});
test("Cursor 429 preserves Retry-After", async () => {
  await assert.rejects(cursor.fetch(fakeContext({ files: config, responses: [json({}, 429, { "retry-after": "90" })] })),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 90);
});
for (const response of [() => json({}), () => new Response("not-json"), () => json({}, 500)]) test("Cursor rejects malformed and failed response", async () => {
  await assert.rejects(cursor.fetch(fakeContext({ files: config, responses: [response()] })), HttpError);
});
test("Cursor unified weekly pool replaces obsolete monthly quota", async () => {
  const context = fakeContext({ files: config, responses: [json(summary), json({}), json({ isUnified: true, hasNonZeroIncludedLimit: true, usagePercent: 100, nextResetTimestampUtc: "2026-12-01T00:00:00Z" })] });
  const [account] = await cursor.fetch(context);
  assert.equal(account.windows[0].minutes, 10080);
  assert.equal(account.windows[0].used_percent, 100);
  assert.equal(account.blocked, true);
  assert.equal(account.windows.some(w => w.name === "30d"), false);
});
test("Cursor uses Linux cursor-agent read-only auth file", async () => {
  const token = jwt({ sub: "auth0|user_123", exp: NOW + 500 });
  const context = fakeContext({ files: { "/home/test/.config/cursor/auth.json": JSON.stringify({ accessToken: token }) }, responses: [json(summary), ...optional()] });
  await cursor.fetch(context);
  assert.equal(context.calls[0].headers.cookie, `WorkosCursorSessionToken=user_123%3A%3A${token}`);
});
test("Cursor ignores expired local token", async () => {
  const token = jwt({ sub: "auth0|user_123", exp: NOW + 30 });
  await assert.rejects(cursor.fetch(fakeContext({ files: { "/home/test/.config/cursor/auth.json": JSON.stringify({ accessToken: token }) } })), NotConfigured);
});
test("Cursor decrypts macOS app auth with Safe Storage", async () => {
  const token = jwt({ sub: "auth0|user_123", exp: NOW + 500 });
  const cipher = createCipheriv("aes-128-cbc", pbkdf2Sync("fake-password", "saltysalt", 1003, 16, "sha1"), Buffer.alloc(16, 32));
  const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(token), cipher.final()]).toString("base64");
  const context = fakeContext({ platform: "darwin", keychain: { "Cursor Safe Storage/Cursor Key": "fake-password" },
    sqlite: { "/home/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb::SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;": [{ value: `cursor-safe-storage:v1:${encrypted}` }] }, responses: [json(summary), ...optional()] });
  await cursor.fetch(context);
  assert.equal(context.calls[0].headers.cookie, `WorkosCursorSessionToken=user_123%3A%3A${token}`);
});
test("Cursor local rejection falls through to browser session", async () => {
  const token = jwt({ sub: "auth0|user_123", exp: NOW + 500 });
  const context = fakeContext({ platform: "darwin", files: config,
    sqlite: { "/home/test/Library/Application Support/Cursor/User/globalStorage/state.vscdb::SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;": [{ value: token }] },
    responses: [json({}, 401), json(summary), ...optional()] });
  await cursor.fetch(context);
  assert.equal(context.calls[1].headers.cookie, "WorkosCursorSessionToken=fake-session");
});
test("Cursor Off skips saved/browser/stored cookies but permits app credentials", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { cursor: { cookieSource: "off", cookieHeader: "session=fake" } } }) } });
  await assert.rejects(cursor.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});
test("Cursor uses cached CodexBar cookie before browser session", async () => {
  const context = fakeContext({ platform: "darwin", files: config,
    keychain: { "com.steipete.codexbar.cache/cookie.cursor": JSON.stringify({ cookieHeader: "WorkosCursorSessionToken=cached-fake" }) }, responses: [json(summary), ...optional()] });
  await cursor.fetch(context);
  assert.equal(context.calls[0].headers.cookie, "WorkosCursorSessionToken=cached-fake");
});
test("Cursor stored cookies respect numeric expiration", async () => {
  const path = "/home/test/.local/share/CodexBar/cursor-session.json";
  const context = fakeContext({ files: { [path]: JSON.stringify([{ Name: "WorkosCursorSessionToken", Value: "fake", Domain: "cursor.com", Expires: NOW - 1, Expires_isDate: true }]) } });
  await assert.rejects(cursor.fetch(context), NotConfigured);
});
test("Cursor unified pool does not revive stale auto percentage", async () => {
  const context = fakeContext({ files: config, responses: [json({ ...summary, individualUsage: { plan: { autoPercentUsed: 60, totalPercentUsed: 30 } } }), json({}), json({ isUnified: true, includedLimitZero: false, usagePercent: 25, nextResetTimestampUtc: "2026-12-01T00:00:00Z" })] });
  const [account] = await cursor.fetch(context);
  assert.deepEqual(account.windows.map(w => w.name), ["7d"]);
});
test("Cursor honors unified current monthly additional-spend budget", async () => {
  const context = fakeContext({ files: config, responses: [json({ ...summary, membershipType: "unified_pro", limitType: "user" }), json({}), json({}),
    json({ availability: "available", monthlyUsage: { usedCents: 500, limitCents: 1000, periodStart: "2026-11-01T00:00:00Z", resetsAt: "2026-12-01T00:00:00Z" } })] });
  const [account] = await cursor.fetch(context);
  assert.equal(account.windows[1].used_percent, 50);
  assert.match(context.calls[3].url, /usage-status\?scope=user$/);
});
test("Cursor reads selected enterprise member budget", async () => {
  const context = fakeContext({ files: config, responses: [json({ ...summary, membershipType: "enterprise" }), json({ email: "user@example.com" }), json({}),
    json({ teams: [{ id: 1 }] }), json({ totalPages: 1, teamMemberSpend: [{ email: "user@example.com", overallSpendCents: 5000, effectivePerUserLimitDollars: 100 }] })] });
  const [account] = await cursor.fetch(context);
  assert.equal(account.windows[0].used_percent, 50);
  assert.match(context.calls[3].url, /dashboard\/teams$/);
});
test("Cursor unreadable app database does not hide browser login", async () => {
  const context = fakeContext({ platform: "darwin", files: config, responses: [json(summary), ...optional()] });
  context.querySqlite = async () => { throw new Error("unreadable database"); };
  const [account] = await cursor.fetch(context);
  assert.equal(account.windows[0].used_percent, 30);
  assert.equal(context.calls[0].headers.cookie, "WorkosCursorSessionToken=fake-session");
});
test("Cursor unreadable legacy session file does not hide CLI login", async () => {
  const token = jwt({ sub: "auth0|user_123", exp: NOW + 500 });
  const context = fakeContext({ files: { "/home/test/.config/cursor/auth.json": JSON.stringify({ accessToken: token }) }, responses: [json(summary), ...optional()] });
  const read = context.readFile;
  context.readFile = async path => {
    if (path.endsWith("cursor-session.json")) throw new Error("unreadable session");
    return read(path);
  };
  await cursor.fetch(context);
  assert.equal(context.calls[0].headers.cookie, `WorkosCursorSessionToken=user_123%3A%3A${token}`);
});
