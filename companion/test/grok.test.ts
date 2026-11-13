import assert from "node:assert/strict";
import { test } from "node:test";
import { grok } from "../src/providers/grok.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Derived from CodexBar's grok parser/fetcher fixtures, with fake identity and future resets.
const fixture = { config: { creditUsagePercent: 12.5, currentPeriod: { start: "2026-11-09T00:00:00Z", end: "2026-11-16T00:00:00Z" }, prepaidBalance: { val: "1240" } } };
const configured = { env: { GROK_OAUTH_TOKEN: "fake-token" } };

test("grok: parses CodexBar-derived fixture", async () => {
  const context = fakeContext({ ...configured, responses: [json(fixture)] });
  const [account] = await grok.fetch(context);
  assert.equal(account.provider, "grok");
  assert.equal(account.windows[0].used_percent, 13);
  assert.ok(account.windows.length <= 2);
  assert.ok(context.calls.every(call => call.url.startsWith("https://")));
});
test("grok: missing credentials", async () => {
  await assert.rejects(grok.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403]) test(`grok: ${status} asks to sign in`, async () => {
  const [account] = await grok.fetch(fakeContext({ ...configured, responses: [json({}, status)] }));
  assert.equal(account.error, "sign in");
});
test("grok: rate limit honors Retry-After", async () => {
  await assert.rejects(grok.fetch(fakeContext({ ...configured, responses: [json({}, 429, { "retry-after": "120" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 120);
});
for (const response of [new Response("not json"), json({}), json({ secret: "never echo" }, 500)]) {
  test(`grok: invalid response ${response.status} is a sanitized HttpError`, async () => {
    await assert.rejects(grok.fetch(fakeContext({ ...configured, responses: [response] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("never echo"));
  });
}

test("Grok: active OIDC credential is preferred to legacy", async () => {
  const context = fakeContext({ files: { "/home/test/.grok/auth.json": JSON.stringify({
    "https://auth.x.ai::fake": { key: "fake-oidc", email: "test@example.com" },
    "https://accounts.x.ai/sign-in": { key: "fake-legacy" },
  }) }, responses: [json(fixture)] });
  const [account] = await grok.fetch(context);
  assert.equal(account.account, "example");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-oidc");
});
test("Grok: ACP CLI billing precedes HTTP", async () => {
  const context = fakeContext({ ...configured, commands: { "grok agent stdio": { code: 0, stderr: "", stdout: JSON.stringify({ id: 2, result: {
    monthlyLimit: { val: 1000 }, usage: { totalUsed: { val: 250 } }, billingCycle: { billingPeriodStart: "2026-11-01T00:00:00Z", billingPeriodEnd: "2026-12-01T00:00:00Z" },
  } }) } } });
  assert.equal((await grok.fetch(context))[0].windows[0].used_percent, 25);
  assert.equal(context.calls.length, 0);
});
test("Grok: cookie gRPC-web quota and invalid trailer", async () => {
  const payload = Buffer.alloc(7);
  payload[0] = 10; payload[1] = 5; payload[2] = 13; payload.writeFloatLE(25, 3);
  const frame = Buffer.alloc(5); frame.writeUInt32BE(payload.length, 1);
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { grok: { cookieHeader: "sso=fake" } } }) }, responses: [new Response(Buffer.concat([frame, payload]))] });
  assert.equal((await grok.fetch(context))[0].windows[0].used_percent, 25);
});

test("Grok: on-demand fallback and matching fallback billing period", async () => {
  const context = fakeContext({ ...configured, responses: [json({ config: { onDemandUsed: { val: 25 }, onDemandCap: { val: 100 },
    currentPeriod: { start: "2026-01-01T00:00:00Z" }, billingPeriodStart: "2026-11-01T00:00:00Z", billingPeriodEnd: "2026-12-01T00:00:00Z" } })] });
  const [account] = await grok.fetch(context);
  assert.equal(account.windows[0].used_percent, 25);
  assert.equal(account.windows[0].minutes, 43200);
});

test("Grok: period-only proxy falls back to bearer gRPC without importing cookies", async () => {
  const payload = Buffer.alloc(7); payload[0] = 10; payload[1] = 5; payload[2] = 13; payload.writeFloatLE(25, 3);
  const frame = Buffer.alloc(5); frame.writeUInt32BE(payload.length, 1);
  const context = fakeContext({ ...configured, responses: [json({ config: { currentPeriod: { start: "2026-11-09T00:00:00Z", end: "2026-11-16T00:00:00Z" } } }), new Response(Buffer.concat([frame, payload]))] });
  assert.equal((await grok.fetch(context))[0].windows[0].used_percent, 25);
  assert.equal(context.calls[1].headers.authorization, "Bearer fake-token");
  assert.equal(context.calls[1].headers.cookie, undefined);
});
