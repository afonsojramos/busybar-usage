import assert from "node:assert/strict";
import { test } from "node:test";
import { parallel } from "../src/providers/parallel.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic response shapes from CodexBar's provider plugin tests.
const fixture = [{"kind": "ok", "data": {"balance": 12345, "pendingDebitBalanceCents": 150}}];
const cookie = "st=fixture-session; soid=fixture-org";
function configured(responses = fixture.map(body => json(body)), entry: Record<string, unknown> = {}) {
  return fakeContext({ files: {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: {
      parallel: { cookieHeader: cookie, ...entry },
    } }),
  }, responses });
}

test("parallel maps the CodexBar fixture", async () => {
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
  const [account] = await parallel.fetch(context);
  assert.deepEqual(account.windows.map(w => w.value), ["$123.45", "$1.50"]);
  assert.equal(account.provider, "parallel");
  assert.ok(account.windows.length <= 2);
  assert.ok(account.windows.every(w => w.value === undefined || w.value.length <= 12));
  assert.ok(context.calls.every(c => c.url.startsWith("https://")));
  assert.equal(context.calls[0].headers.cookie, cookie);
});

test("parallel skips a missing session", async () => {
  const context = fakeContext({});
  await assert.rejects(parallel.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("parallel honors disabled cookies", async () => {
  const context = configured([], { cookieSource: "off" });
  await assert.rejects(parallel.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

for (const status of [401, 403]) test(`parallel maps HTTP ${status} to sign in`, async () => {
  const [account] = await parallel.fetch(configured([json({ private: "never include" }, status)]));
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("parallel honors Retry-After", async () => {
  await assert.rejects(parallel.fetch(configured([json({}, 429, { "retry-after": "17" })])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 17);
  await assert.rejects(parallel.fetch(configured([json({}, 429)])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300);
});

test("parallel rejects malformed bodies and failed HTTP without leaking data", async () => {
  for (const response of [new Response("fake-private-token", { status: 200 }), json({}, 500), json(null)]) {
    await assert.rejects(parallel.fetch(configured([response])), (error: unknown) =>
      error instanceof HttpError && !error.message.includes("fake-private-token"));
  }
});

test("parallel treats redirect and HTML login pages as expired sessions", async () => {
  for (const response of [new Response("", { status: 302, headers: { location: "https://untrusted.test" } }),
    new Response("<html>login</html>", { headers: { "content-type": "text/html" } })]) {
    const [account] = await parallel.fetch(configured([response]));
    assert.equal(account.error, "sign in");
  }
});

test("parallel ignores absent or nonnumeric pending debit but requires numeric balance", async () => {
  for (const pending of [undefined, 0, "150"]) {
    const [account] = await parallel.fetch(configured([json({ kind: "ok", data: { balance: -1, pendingDebitBalanceCents: pending } })]));
    assert.equal(account.windows.length, 1);
    assert.equal(account.windows[0].value, "$-0.01");
  }
  for (const body of [{ kind: "error", data: { balance: 1 } }, { kind: "ok", data: { balance: "1" } }])
    await assert.rejects(parallel.fetch(configured([json(body)])), HttpError);
});
