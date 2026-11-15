import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { raycast } from "../src/providers/raycast.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const credentials = {
  files: {
    "/home/test/.config/busybar-usage/config.json":
      '{"providers": {"raycast": {"cookieHeader": "__raycast_session=fake; csrf_token=fake; other=excluded"}}}',
  },
};
// Based on CodexBar's raycast plugin fixtures, with reset times moved after the test clock.
const happy = () => [
  json({
    remaining_balance_credits: "125",
    total_balance_credits: "500",
    next_credits_at: new Date((NOW + 86400) * 1000).toISOString(),
  }),
];

test("raycast: CodexBar fixture", async () => {
  const ctx = fakeContext({ ...credentials, responses: happy() });
  const [account] = await raycast.fetch(ctx);
  assert.equal(account.error, undefined);
  assert.equal(account.windows[0].used_percent, 75);
  assert.equal(account.windows[0].minutes, null);
});

test("raycast: missing credentials", async () => {
  await assert.rejects(raycast.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`raycast: ${status} requires sign in`, async () => {
    const ctx = fakeContext({ ...credentials, responses: [json({ private: "must not leak" }, status)] });
    const [account] = await raycast.fetch(ctx);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("raycast: rate limit", async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({}, 429, { "retry-after": "17" })] });
  await assert.rejects(raycast.fetch(ctx), (e: unknown) => e instanceof RateLimited && e.until === NOW + 17);
});

test("raycast: invalid body is sanitized", async () => {
  const ctx = fakeContext({ ...credentials, responses: [new Response("private malformed body")] });
  await assert.rejects(raycast.fetch(ctx), (e: unknown) => e instanceof HttpError && !e.message.includes("private"));
});

test("raycast: rollover and zero allowance", async () => {
  for (const [left, total, percent] of [
    [750, 500, 0],
    [0, 0, null],
  ]) {
    const ctx = fakeContext({
      ...credentials,
      responses: [json({ remaining_balance_credits: left, total_balance_credits: total })],
    });
    assert.equal((await raycast.fetch(ctx))[0].windows[0].used_percent, percent);
    assert.equal(ctx.calls[0].headers.cookie, "__raycast_session=fake; csrf_token=fake");
  }
});

test("raycast: cookie source off prevents requests even with a saved header", async () => {
  const files = {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({
      providers: { raycast: { cookieSource: "off", cookieHeader: "fake" } },
    }),
  };
  const ctx = fakeContext({ files });
  await assert.rejects(raycast.fetch(ctx), NotConfigured);
  assert.equal(ctx.calls.length, 0);
});
