import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { abacus } from "../src/providers/abacus.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { abacus: { cookieHeader: "sessionid=fake-session" } } }) };
const usage = { success: true, result: { totalComputePoints: 1000, computePointsLeft: 750 } };

test("Abacus maps CodexBar compute-point fixture and optional billing reset", async () => {
  const context = fakeContext({ files, responses: [json(usage), json({ success: true, result: { nextBillingDate: "2026-12-01T00:00:00Z", currentTier: "Pro" } })] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal);
    assert.equal(init?.redirect, "manual");
    if (String(input).endsWith("_getBillingInfo")) {
      assert.equal(init?.method, "POST");
      assert.equal(init?.body, "{}");
    }
    return fetch(input, init);
  };
  const [account] = await abacus.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows, [{ name: "30d", minutes: 43200, used_percent: 25, resets_at: Date.parse("2026-12-01T00:00:00Z") / 1000 }]);
  assert.equal(context.calls[0].url, "https://apps.abacus.ai/api/_getOrganizationComputePoints");
  assert.equal(context.calls[1].url, "https://apps.abacus.ai/api/_getBillingInfo");
  assert.equal(context.calls[0].headers.cookie, "sessionid=fake-session");
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["content-type"], "application/json");
});

test("Abacus missing session is not configured", async () => {
  await assert.rejects(abacus.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`Abacus ${status} asks to sign in`, async () => {
    const [account] = await abacus.fetch(fakeContext({ files, responses: [json({}, status)] }));
    assert.equal(account.error, "sign in");
  });
}

test("Abacus recognizes an expired session in a successful HTTP response", async () => {
  const [account] = await abacus.fetch(fakeContext({ files, responses: [json({ success: false, error: "Session expired" })] }));
  assert.equal(account.error, "sign in");
});

test("Abacus honors Retry-After", async () => {
  await assert.rejects(abacus.fetch(fakeContext({ files, responses: [json({}, 429, { "retry-after": "41" })] })), (error: unknown) => error instanceof RateLimited && error.until === NOW + 41);
});

for (const response of [json({}, 403), json({}, 500), new Response("bad JSON")]) {
  test(`Abacus optional billing ${response.status} cannot hide valid credits`, async () => {
    const [account] = await abacus.fetch(fakeContext({ files, responses: [json(usage), response] }));
    assert.equal(account.windows[0].used_percent, 25);
    assert.equal(account.windows[0].resets_at, null);
  });
}

test("Abacus zero allowance stays zero and full allowance blocks", async () => {
  for (const total of [0, 100]) {
    const [account] = await abacus.fetch(fakeContext({ files, responses: [json({ success: true, result: { totalComputePoints: total, computePointsLeft: 0 } }), json({}, 500)] }));
    assert.equal(account.windows[0].used_percent, total);
    assert.equal(account.blocked, total > 0);
  }
});

for (const response of [json({ success: false }), json({ success: true, result: {} }), new Response("fake-secret"), json({}, 500)]) {
  test(`Abacus malformed response ${response.status} throws HttpError`, async () => {
    await assert.rejects(abacus.fetch(fakeContext({ files, responses: [response] })), HttpError);
  });
}


test("Abacus rejects an overflowing computed percentage", async () => {
  await assert.rejects(abacus.fetch(fakeContext({ files, responses: [
    json({ success: true, result: { totalComputePoints: 1, computePointsLeft: -1e308 } }), json({}, 500),
  ] })), HttpError);
});
