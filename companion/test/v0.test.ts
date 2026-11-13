import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { v0 } from "../src/providers/v0.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "V0_API_KEY": "fake-key" };
const fixture = [{ "billingType": "token", "data": { "balance": { "remaining": 750, "total": 1000 }, "billingCycle": { "start": 1797325200, "end": 1800003600 } } }, { "remaining": 80, "reset": 1800001800, "limit": 100 }];

test("v0: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map(body => json(body)) });
  const [account] = await v0.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "v0");
  assert.deepEqual(account.windows.map(w => w.used_percent), [20, 25]);
  assert.deepEqual(account.windows.map(w => w.value ?? null), [null, null]);
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://api.v0.dev/v1/user/billing"));
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-key");
});

test("v0: missing credential", async () => {
  await assert.rejects(v0.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`v0: ${status} requires sign in`, async () => {
  const [account] = await v0.fetch(fakeContext({ env, responses: [json({}, status)] }));
  assert.equal(account?.error, "sign in");
  assert.deepEqual(account?.windows, []);
});

test("v0: rate limit preserves Retry-After", async () => {
  await assert.rejects(v0.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    error => error instanceof RateLimited && error.until === NOW + 42);
  await assert.rejects(v0.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    error => error instanceof RateLimited && error.until === NOW + 300);
});

test("v0: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(v0.fetch(fakeContext({ env, responses: [response] })),
      error => error instanceof HttpError && !error.message.includes("fake-private-body"));
  }
});

test("v0: scope applies to both calls and legacy unknown remaining is unavailable", async () => {
  const context = fakeContext({
    env: { ...env, V0_SCOPE: "project/a" }, responses: [
      json({ billingType: "legacy", data: { limit: 100, reset: 1800003600000 } }), json({ limit: 10, remaining: 0 })]
  });
  const [a] = await v0.fetch(context);
  assert.equal(a?.windows[1]?.value, "Unavailable");
  assert.equal(a?.windows[1]?.resets_at, 1800003600);
  assert.equal(a?.windows[0]?.used_percent, 100);
  assert.equal(a?.blocked, true);
  assert.ok(context.calls.every(c => c.url.endsWith("?scope=project%2Fa")));
});

test("v0: invalid token billing and second-request auth failure", async () => {
  await assert.rejects(v0.fetch(fakeContext({ env, responses: [json({ billingType: "token", data: { balance: { total: -1, remaining: 1 }, billingCycle: {} } })] })), HttpError);
  const [a] = await v0.fetch(fakeContext({ env, responses: [json(fixture[0]), json({}, 403)] }));
  assert.equal(a?.error, "sign in");
});


test("v0: config key and request safety", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { v0: { apiKey: "fake-config", workspaceID: "team-1234" } } }) }, responses: fixture.map(b => json(b)) });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.redirect, "error");
    return fetch(input, init);
  };
  await v0.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-config");
});

test("v0: token billing requires remaining and validates on-demand without mixing it", async () => {
  for (const data of [{ balance: { total: 20 }, billingCycle: {} },
  { balance: { total: 20, remaining: 1 }, billingCycle: {}, onDemand: "invalid" },
  { balance: { total: 20, remaining: 1 }, billingCycle: {}, onDemand: { balance: "10" } }])
    await assert.rejects(v0.fetch(fakeContext({ env, responses: [json({ billingType: "token", data })] })), HttpError);
  const [a] = await v0.fetch(fakeContext({ env, responses: [json({ billingType: "token", data: { balance: { total: 20, remaining: 0 }, billingCycle: {}, onDemand: { balance: 10 } } }), json(fixture[1])] }));
  assert.equal(a?.windows[1]?.used_percent, 100);
});
