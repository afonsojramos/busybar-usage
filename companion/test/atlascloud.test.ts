import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { atlascloud } from "../src/providers/atlascloud.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "ATLASCLOUD_API_KEY": "fake-key" };
const fixture = [{ "object": "balance", "scope": "account", "available": { "currency": "usd", "value": "12.40" } }];

test("atlascloud: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map(body => json(body)) });
  const [account] = await atlascloud.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "atlascloud");
  assert.deepEqual(account.windows.map(w => w.used_percent), [null]);
  assert.deepEqual(account.windows.map(w => w.value ?? null), ["$12.40"]);
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://api.atlascloud.ai/public/v1/balance"));
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-key");
});

test("atlascloud: missing credential", async () => {
  await assert.rejects(atlascloud.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`atlascloud: ${status} requires sign in`, async () => {
  const [account] = await atlascloud.fetch(fakeContext({ env, responses: [json({}, status)] }));
  assert.equal(account?.error, "sign in");
  assert.deepEqual(account?.windows, []);
});

test("atlascloud: rate limit preserves Retry-After", async () => {
  await assert.rejects(atlascloud.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    error => error instanceof RateLimited && error.until === NOW + 42);
  await assert.rejects(atlascloud.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    error => error instanceof RateLimited && error.until === NOW + 300);
});

test("atlascloud: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(atlascloud.fetch(fakeContext({ env, responses: [response] })),
      error => error instanceof HttpError && !error.message.includes("fake-private-body"));
  }
});

test("atlascloud: preserves zero and debt, rejects wrong scope or currency", async () => {
  for (const value of ["0", "-2.50"]) {
    const [a] = await atlascloud.fetch(fakeContext({ env, responses: [json({ object: "balance", scope: "account", available: { currency: "usd", value } })] }));
    assert.equal(a?.windows[0]?.value, `$${Number(value).toFixed(2)}`);
  }
  for (const body of [{ object: "balance", scope: "key", available: { currency: "usd", value: "1" } },
  { object: "balance", scope: "account", available: { currency: "eur", value: "1" } },
  { object: "balance", scope: "account", available: { currency: "usd", value: "NaN" } }])
    await assert.rejects(atlascloud.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
});


test("atlascloud: config key and request safety", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { atlascloud: { apiKey: "fake-config", workspaceID: "team-1234" } } }) }, responses: fixture.map(b => json(b)) });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.redirect, "error");
    return fetch(input, init);
  };
  await atlascloud.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-config");
});
