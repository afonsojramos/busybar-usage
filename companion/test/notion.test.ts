import assert from "node:assert/strict";
import { test } from "node:test";
import { notion } from "../src/providers/notion.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
import { readFileSync } from "node:fs";
const spaces: unknown = JSON.parse(readFileSync(new URL("./fixtures/notion/get-spaces.json", import.meta.url), "utf8"));
const usage = JSON.parse(readFileSync(new URL("./fixtures/notion/get-credit-rate-limit-status.json", import.meta.url), "utf8"));
const credentials = { "files": { "/home/test/.config/busybar-usage/config.json": "{\"providers\": {\"notion\": {\"cookieHeader\": \"token_v2=fake\"}}}" } };
// Based on CodexBar's notion plugin fixtures, with reset times moved after the test clock.
const happy = () => [json(spaces), json({ ...usage, billingPeriodWindow: { ...usage.billingPeriodWindow, periodEndMs: (NOW + 86400) * 1000 } })];

test("notion: CodexBar fixture", async () => {
  const ctx = fakeContext({ ...credentials, responses: happy() });
  const [account] = await notion.fetch(ctx);
  assert.equal(account.error, undefined);
  assert.deepEqual(account.windows.map(w => w.used_percent), [43, 18]); assert.equal(account.account, "example");
});

test("notion: missing credentials", async () => {
  await assert.rejects(notion.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`notion: ${status} requires sign in`, async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({ private: "must not leak" }, status)] });
  const [account] = await notion.fetch(ctx);
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("notion: rate limit", async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({}, 429, { "retry-after": "17" })] });
  await assert.rejects(notion.fetch(ctx), (e: unknown) => e instanceof RateLimited && e.until === NOW + 17);
});

test("notion: invalid body is sanitized", async () => {
  const ctx = fakeContext({ ...credentials, responses: [new Response("private malformed body")] });
  await assert.rejects(notion.fetch(ctx), (e: unknown) => e instanceof HttpError && !e.message.includes("private"));
});

test("notion: configured workspace and overage", async () => {
  const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { notion: { cookieHeader: "token_v2=fake", workspaceID: "11111111222233334444555555555555" } } }) };
  const ctx = fakeContext({ files, responses: [json(spaces), json({ window: { used: 150, limit: 100, window: "6h" }, resetsInSeconds: 3600 })] });
  const account = (await notion.fetch(ctx))[0];
  assert.equal(account.blocked, true);
  assert.equal(account.windows[0].used_percent, 150);
  assert.equal(account.windows[0].minutes, 360);
});

test("notion: saved CodexBar session", async () => {
  const ctx = fakeContext({ platform: "darwin", files: { "/home/test/Library/Application Support/CodexBar/notion-session.json": JSON.stringify({ tokenV2: "fake-saved" }) }, responses: happy() });
  await notion.fetch(ctx);
  assert.equal(ctx.calls[0].headers.cookie, "token_v2=fake-saved");
});

test("notion: bare token and captured cURL use only approved headers", async () => {
  for (const cookieHeader of ["fake-bare", "curl 'https://app.notion.com/api/v3/getSpaces' -H 'Cookie: token_v2=fake-bare' -H 'Notion-Client-Version: fixture-version' -H 'Authorization: must-not-forward'"]) {
    const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { notion: { cookieSource: "manual", cookieHeader } } }) };
    const ctx = fakeContext({ files, responses: happy() });
    await notion.fetch(ctx);
    assert.equal(ctx.calls[0].headers.cookie, "token_v2=fake-bare");
    assert.equal(ctx.calls[0].headers.authorization, undefined);
    if (cookieHeader.startsWith("curl")) assert.equal(ctx.calls[0].headers["notion-client-version"], "fixture-version");
  }
});

test("notion: cookie source off prevents requests even with a saved header", async () => {
  const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { notion: { cookieSource: "off", cookieHeader: "fake" } } }) };
  const ctx = fakeContext({ files });
  await assert.rejects(notion.fetch(ctx), NotConfigured);
  assert.equal(ctx.calls.length, 0);
});
