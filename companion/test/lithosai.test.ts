import assert from "node:assert/strict";
import { test } from "node:test";
import { lithosai } from "../src/providers/lithosai.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic response shapes from CodexBar's provider plugin tests.
const fixture = [{"user": {"email": "person@example.test"}, "activeOrganization": {"id": "org-fixture", "name": "Synthetic"}}, {"balanceNanos": 4707099860, "hasCard": true, "onHold": false}];
const cookie = "__Host-console_session=fixture-session; __Host-console_csrf=fixture-csrf";
function configured(responses = fixture.map(body => json(body)), entry: Record<string, unknown> = {}) {
  return fakeContext({ files: {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: {
      lithosai: { cookieHeader: cookie, ...entry },
    } }),
  }, responses });
}

test("lithosai maps the CodexBar fixture", async () => {
  const context = configured();
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "manual");
    if (init.method === "POST") {
      assert.equal(new Headers(init.headers).get("content-type"), "application/json");
      assert.doesNotThrow(() => JSON.parse(String(init.body)));
    }
    return fetch(input, init);
  };
  const [account] = await lithosai.fetch(context);
  assert.equal(account.windows[0].value, "$4.71"); assert.equal(account.account, "example");
  assert.equal(context.calls[1].headers["x-organization-id"], "org-fixture");
  assert.equal(context.calls[0].headers["x-console-csrf"], "fixture-csrf");
  assert.equal(account.provider, "lithosai");
  assert.ok(account.windows.length <= 2);
  assert.ok(account.windows.every(w => w.value === undefined || w.value.length <= 12));
  assert.ok(context.calls.every(c => c.url.startsWith("https://")));
  assert.equal(context.calls[0].headers.cookie, cookie);
});

test("lithosai skips a missing session", async () => {
  const context = fakeContext({});
  await assert.rejects(lithosai.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("lithosai honors disabled cookies", async () => {
  const context = configured([], { cookieSource: "off" });
  await assert.rejects(lithosai.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

for (const status of [401, 403]) test(`lithosai maps HTTP ${status} to sign in`, async () => {
  const [account] = await lithosai.fetch(configured([json({ private: "never include" }, status)]));
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("lithosai honors Retry-After", async () => {
  await assert.rejects(lithosai.fetch(configured([json({}, 429, { "retry-after": "17" })])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 17);
  await assert.rejects(lithosai.fetch(configured([json({}, 429)])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300);
});

test("lithosai rejects malformed bodies and failed HTTP without leaking data", async () => {
  for (const response of [new Response("fake-private-token", { status: 200 }), json({}, 500), json(null)]) {
    await assert.rejects(lithosai.fetch(configured([response])), (error: unknown) =>
      error instanceof HttpError && !error.message.includes("fake-private-token"));
  }
});

test("lithosai requires both cookies and validates billing flags and integer nanos", async () => {
  await assert.rejects(lithosai.fetch(configured([], { cookieHeader: "__Host-console_session=fake" })), NotConfigured);
  for (const balance of [0, -1000000000, 1000000]) {
    const [account] = await lithosai.fetch(configured([json(fixture[0]), json({ balanceNanos: balance, hasCard: true, onHold: false })]));
    assert.equal(account.windows[0].value, balance === 1000000 ? "<$0.01" : balance === 0 ? "$0.00" : "$-1.00");
  }
  for (const balance of ["1000", 0.5, null]) await assert.rejects(lithosai.fetch(configured([
    json(fixture[0]), json({ balanceNanos: balance, hasCard: true, onHold: false }),
  ])), HttpError);
  await assert.rejects(lithosai.fetch(configured([json({ user: {}, activeOrganization: { id: "../escape" } })])), HttpError);
  const [held] = await lithosai.fetch(configured([json(fixture[0]), json({ balanceNanos: 1000000000, hasCard: false, onHold: true })]));
  assert.equal(held.blocked, true);
});
