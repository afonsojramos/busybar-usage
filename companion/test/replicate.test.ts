import assert from "node:assert/strict";
import { test } from "node:test";
import { replicate } from "../src/providers/replicate.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const credentials = { "files": { "/home/test/.config/busybar-usage/config.json": "{\"providers\": {\"replicate\": {\"cookieHeader\": \"sessionid=fake\"}}}" } };
// Based on CodexBar's replicate plugin fixtures, with reset times moved after the test clock.
const happy = () => [new Response('<script type="application/json" id="react-component-props-billing-page">{"page":{"account":{"kind":"user","username":"demo-user"}}}</script>'), json({ invoices: [{ type: "monthly-usage", ended_before: null, total_cost_before_adjustments: "12.40" }] }), json({ unused_credit: "80" })];

test("replicate: CodexBar fixture", async () => {
  const ctx = fakeContext({ ...credentials, responses: happy() });
  const [account] = await replicate.fetch(ctx);
  assert.equal(account.error, undefined);
  assert.deepEqual(account.windows.map(w => w.value), ["$12.40", "$80.00"]);
});

test("replicate: missing credentials", async () => {
  await assert.rejects(replicate.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`replicate: ${status} requires sign in`, async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({ private: "must not leak" }, status)] });
  const [account] = await replicate.fetch(ctx);
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("replicate: rate limit", async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({}, 429, { "retry-after": "17" })] });
  await assert.rejects(replicate.fetch(ctx), (e: unknown) => e instanceof RateLimited && e.until === NOW + 17);
});

test("replicate: invalid body is sanitized", async () => {
  const ctx = fakeContext({ ...credentials, responses: [new Response("private malformed body")] });
  await assert.rejects(replicate.fetch(ctx), (e: unknown) => e instanceof HttpError && !e.message.includes("private"));
});

test("replicate: organization account and unavailable optional credit", async () => {
  const responses = happy();
  responses[0] = new Response('<script type="application/json" id="react-component-props-billing-page">{"page":{"account":{"kind":"organization","username":"demo-org"}}}</script>');
  responses[2] = json({}, 503);
  const ctx = fakeContext({ ...credentials, responses });
  assert.deepEqual((await replicate.fetch(ctx))[0].windows.map(w => w.value), ["$12.40"]);
  assert.equal(ctx.calls[1].url, "https://replicate.com/api/organizations/demo-org/invoices");
});

test("replicate: cookie source off prevents requests even with a saved header", async () => {
  const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { replicate: { cookieSource: "off", cookieHeader: "fake" } } }) };
  const ctx = fakeContext({ files });
  await assert.rejects(replicate.fetch(ctx), NotConfigured);
  assert.equal(ctx.calls.length, 0);
});
