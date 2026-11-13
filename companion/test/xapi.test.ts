import assert from "node:assert/strict";
import { test } from "node:test";
import { xapi } from "../src/providers/xapi.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const credentials = { "files": { "/home/test/.config/busybar-usage/config.json": "{\"providers\": {\"xapi\": {\"cookieHeader\": \"auth_token=fake; ct0=fake-csrf\"}}}" } };
// Based on CodexBar's xapi plugin fixtures, with reset times moved after the test clock.
const happy = () => [json({ account: { id: "fake-account" } }), json({ credits: { balance: 12.4 }, freeCredits: { balance: 2 } })];

test("xapi: CodexBar fixture", async () => {
  const ctx = fakeContext({ ...credentials, responses: happy() });
  const [account] = await xapi.fetch(ctx);
  assert.equal(account.error, undefined);
  assert.equal(account.windows[0].value, "$14.40"); assert.equal(ctx.calls[0].headers["x-csrf-token"], "fake-csrf");
});

test("xapi: missing credentials", async () => {
  await assert.rejects(xapi.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`xapi: ${status} requires sign in`, async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({ private: "must not leak" }, status)] });
  const [account] = await xapi.fetch(ctx);
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("xapi: rate limit", async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({}, 429, { "retry-after": "17" })] });
  await assert.rejects(xapi.fetch(ctx), (e: unknown) => e instanceof RateLimited && e.until === NOW + 17);
});

test("xapi: invalid body is sanitized", async () => {
  const ctx = fakeContext({ ...credentials, responses: [new Response("private malformed body")] });
  await assert.rejects(xapi.fetch(ctx), (e: unknown) => e instanceof HttpError && !e.message.includes("private"));
});

test("xapi: missing free credit, negative balance and console auth error 215", async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({ account: { id: 123 } }), json({ credits: { balance: -12.4 } })] });
  assert.equal((await xapi.fetch(ctx))[0].windows[0].value, "$-12.40");
  const expired = fakeContext({ ...credentials, responses: [json({ errors: [{ code: 215 }] }, 400)] });
  assert.equal((await xapi.fetch(expired))[0].error, "sign in");
});

test("xapi: cookie source off prevents requests even with a saved header", async () => {
  const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { xapi: { cookieSource: "off", cookieHeader: "fake" } } }) };
  const ctx = fakeContext({ files });
  await assert.rejects(xapi.fetch(ctx), NotConfigured);
  assert.equal(ctx.calls.length, 0);
});
