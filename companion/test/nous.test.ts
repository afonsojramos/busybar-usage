import assert from "node:assert/strict";
import { test } from "node:test";
import { nous } from "../src/providers/nous.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "NOUS_PORTAL_ACCESS_TOKEN": "fake-token" };
const fixture = [{ "user": { "email": "dev@example.com" }, "subscription": { "plan": "Ultra", "monthly_credits": 220, "credits_remaining": 55, "rollover_credits": 0, "current_period_end": "2027-10-12T04:29:00.000Z" }, "purchased_credits_remaining": 19.25, "paid_service_access": { "total_usable_credits": 74.25 } }];

test("nous: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map(body => json(body)) });
  const [account] = await nous.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "nous");
  assert.deepEqual(account.windows.map(w => w.used_percent), [75, null]);
  assert.deepEqual(account.windows.map(w => w.value ?? null), [null, "$74.25"]);
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://portal.nousresearch.com/api/oauth/account"));
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-token");
});

test("nous: missing credential", async () => {
  await assert.rejects(nous.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`nous: ${status} requires sign in`, async () => {
  const [account] = await nous.fetch(fakeContext({ env, responses: [json({}, status)] }));
  assert.equal(account?.error, "sign in");
  assert.deepEqual(account?.windows, []);
});

test("nous: rate limit preserves Retry-After", async () => {
  await assert.rejects(nous.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    error => error instanceof RateLimited && error.until === NOW + 42);
  await assert.rejects(nous.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    error => error instanceof RateLimited && error.until === NOW + 300);
});

test("nous: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(nous.fetch(fakeContext({ env, responses: [response] })),
      error => error instanceof HttpError && !error.message.includes("fake-private-body"));
  }
});

test("nous: Hermes profile and shared-file fallback, exclusive custom home", async () => {
  const auth = { providers: { nous: { access_token: "fake-local", expires_at: "2027-01-01T00:00:00Z" } } };
  const context = fakeContext({ files: { "/home/test/.hermes/auth.json": JSON.stringify(auth) }, responses: fixture.map(b => json(b)) });
  await nous.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-local");
  await assert.rejects(nous.fetch(fakeContext({ env: { HERMES_HOME: "/custom" }, files: { "/home/test/.hermes/auth.json": JSON.stringify(auth) } })), NotConfigured);
  const shared = fakeContext({
    files: {
      "/home/test/.hermes/auth.json": JSON.stringify({ access_token: "expired", expires_at: "2020-01-01T00:00:00Z" }),
      "/home/test/.hermes/shared/nous_auth.json": JSON.stringify({ access_token: "fake-shared" })
    }, responses: fixture.map(b => json(b))
  });
  await nous.fetch(shared);
  assert.equal(shared.calls[0]?.headers.authorization, "Bearer fake-shared");
});

test("nous: credential pool order and portal trust policy", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.hermes/auth.json": JSON.stringify({
        credential_pool: {
          nous: [
            { access_token: "fake-old", agent_key_expires_at: "2027-01-01T00:00:00Z" },
            { access_token: "fake-new", agent_key_expires_at: "2028-01-01T00:00:00Z", portal_base_url: "https://evil.example" }
          ]
        }
      })
    }, responses: fixture.map(b => json(b))
  });
  await nous.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-new");
  assert.equal(context.calls[0]?.url, "https://portal.nousresearch.com/api/oauth/account");
  const trusted = fakeContext({ files: { "/home/test/.hermes/auth.json": JSON.stringify({ access_token: "fake-local", portal_base_url: "https://preview.nousresearch.com" }) }, responses: fixture.map(b => json(b)) });
  await nous.fetch(trusted);
  assert.ok(trusted.calls[0]?.url.startsWith("https://preview.nousresearch.com/"));
  const override = fakeContext({ env: { ...env, NOUS_PORTAL_BASE_URL: "http://localhost", HERMES_PORTAL_BASE_URL: "https://preview.example" }, responses: fixture.map(b => json(b)) });
  await nous.fetch(override);
  assert.ok(override.calls[0]?.url.startsWith("https://preview.example/"));
});

test("nous: expired JWT never leaves machine and free balances stay values", async () => {
  const token = `e30.${Buffer.from(JSON.stringify({ exp: NOW + 30 })).toString("base64url")}.fake`;
  const context = fakeContext({ env: { NOUS_PORTAL_ACCESS_TOKEN: token } });
  const [expired] = await nous.fetch(context);
  assert.equal(expired?.error, "sign in");
  assert.equal(context.calls.length, 0);
  const [free] = await nous.fetch(fakeContext({ env, responses: [json({ subscription: null, purchased_credits_remaining: "0" })] }));
  assert.equal(free?.windows[0]?.value, "$0.00");
  const [blocked] = await nous.fetch(fakeContext({ env, responses: [json({ subscription: { monthly_credits: "22", credits_remaining: "0" } })] }));
  assert.equal(blocked?.blocked, true);
  await assert.rejects(nous.fetch(fakeContext({ env, responses: [json({ purchased_credits_remaining: "NaN" })] })), HttpError);
});


test("nous: config key and request safety", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { nous: { apiKey: "fake-config", workspaceID: "team-1234" } } }) }, responses: fixture.map(b => json(b)) });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.redirect, "error");
    return fetch(input, init);
  };
  await nous.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-config");
});
