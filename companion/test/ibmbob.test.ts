import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { ibmbob } from "../src/providers/ibmbob.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "BOBSHELL_API_KEY": "fake-key" };
const fixture = [{ "instances": [{ "instance_id": "instance-one", "user_id": "user-one", "teams": [{ "id": "team-one", "budget_limit": 100 }], "refresh_at": 1800000000 }] }, { "usage": 25 }];

test("ibmbob: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map(body => json(body)) });
  const [account] = await ibmbob.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "ibmbob");
  assert.deepEqual(account.windows.map(w => w.used_percent), [25]);
  assert.deepEqual(account.windows.map(w => w.value ?? null), [null]);
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://api.us-east.bob.ibm.com/admin/v1/profile"));
  assert.equal(context.calls[0]?.headers.authorization, "Apikey fake-key");
});

test("ibmbob: missing credential", async () => {
  await assert.rejects(ibmbob.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`ibmbob: ${status} requires sign in`, async () => {
  const [account] = await ibmbob.fetch(fakeContext({ env, responses: [json({}, status)] }));
  assert.equal(account?.error, "sign in");
  assert.deepEqual(account?.windows, []);
});

test("ibmbob: rate limit preserves Retry-After", async () => {
  await assert.rejects(ibmbob.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    error => error instanceof RateLimited && error.until === NOW + 42);
  await assert.rejects(ibmbob.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    error => error instanceof RateLimited && error.until === NOW + 300);
});

test("ibmbob: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(ibmbob.fetch(fakeContext({ env, responses: [response] })),
      error => error instanceof HttpError && !error.message.includes("fake-private-body"));
  }
});

test("ibmbob: regional routing, JWT auth, limit fallback and aggregate usage", async () => {
  const token = `e30.${Buffer.from('{"exp":1900000000}').toString("base64url")}.fake`;
  const context = fakeContext({
    env: { BOBSHELL_API_KEY: token }, responses: [json({
      instances: [
        { instance_id: "i1", user_id: "u1", refresh_at: "2027-01-01T00:00:00Z", teams: [{ id: "t1", budget_limit: 100 }] },
        { instance_id: "i2", user_id: "u2", region_domain: "eu-de.bob.ibm.com", teams: [{ id: "t2", budget_limit: 100 }] }
      ]
    }), json({ usage: 10 }), json({ usage: 25 })]
  });
  const [a] = await ibmbob.fetch(context);
  assert.equal(a?.windows[0]?.used_percent, 18);
  assert.equal(context.calls[2]?.url, "https://api.eu-de.bob.ibm.com/admin/v1/teams/t2/users/u2");
  assert.equal(context.calls[2]?.headers["x-team-id"], "t2");
  assert.equal(context.calls[2]?.headers.authorization, `Bearer ${token}`);
});

test("ibmbob: refuses untrusted regional hosts before sending credential", async () => {
  for (const host of ["evil.example", "bob.ibm.com.evil.example", "eu-de.bob.ibm.com/path", "bob.ibm.com:443", "bob.ibm.com@evil.example"]) {
    const context = fakeContext({ env, responses: [json({ instances: [{ instance_id: "i", user_id: "u", region_domain: host, teams: [{ id: "t" }] }] })] });
    await assert.rejects(ibmbob.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});


test("ibmbob: config key and request safety", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { ibmbob: { apiKey: "fake-config", workspaceID: "team-1234" } } }) }, responses: fixture.map(b => json(b)) });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.redirect, "error");
    return fetch(input, init);
  };
  await ibmbob.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Apikey fake-config");
});
