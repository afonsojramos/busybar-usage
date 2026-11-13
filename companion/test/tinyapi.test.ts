import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { tinyapi } from "../src/providers/tinyapi.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic response shapes from CodexBar's provider plugin tests.
const fixture = [{ success: true, data: { totalAvailable: 125.25 } }];
const cookie = "session=fake";
function configured(responses = fixture.map((body) => json(body)), entry: Record<string, unknown> = {}) {
  return fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: {
          tinyapi: { cookieHeader: cookie, ...entry },
        },
      }),
    },
    responses,
  });
}

test("tinyapi maps the CodexBar fixture", async () => {
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
  const [account] = await tinyapi.fetch(context);
  assert.equal(account.windows[0].value, "125.25 cr");
  assert.equal(account.provider, "tinyapi");
  assert.ok(account.windows.length <= 2);
  assert.ok(account.windows.every((w) => w.value === undefined || w.value.length <= 12));
  assert.ok(context.calls.every((c) => c.url.startsWith("https://")));
  assert.equal(context.calls[0].headers.cookie, cookie);
});

test("tinyapi skips a missing session", async () => {
  const context = fakeContext({});
  await assert.rejects(tinyapi.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("tinyapi honors disabled cookies", async () => {
  const context = configured([], { cookieSource: "off" });
  await assert.rejects(tinyapi.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

for (const status of [401, 403])
  test(`tinyapi maps HTTP ${status} to sign in`, async () => {
    const [account] = await tinyapi.fetch(configured([json({ private: "never include" }, status)]));
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("tinyapi honors Retry-After", async () => {
  await assert.rejects(
    tinyapi.fetch(configured([json({}, 429, { "retry-after": "17" })])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 17,
  );
  await assert.rejects(
    tinyapi.fetch(configured([json({}, 429)])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300,
  );
});

test("tinyapi rejects malformed bodies and failed HTTP without leaking data", async () => {
  for (const response of [new Response("fake-private-token", { status: 200 }), json({}, 500), json(null)]) {
    await assert.rejects(
      tinyapi.fetch(configured([response])),
      (error: unknown) => error instanceof HttpError && !error.message.includes("fake-private-token"),
    );
  }
});

test("tinyapi preserves zero and rejects invented or invalid credit amounts", async () => {
  const [zero] = await tinyapi.fetch(configured([json({ success: true, data: { totalAvailable: 0 } })]));
  assert.equal(zero.windows[0].value, "0 cr");
  assert.equal(zero.blocked, true);
  for (const amount of ["125", -1, null])
    await assert.rejects(
      tinyapi.fetch(configured([json({ success: true, data: { totalAvailable: amount } })])),
      HttpError,
    );
  await assert.rejects(tinyapi.fetch(configured([json({ success: false, data: { totalAvailable: 1 } })])), HttpError);
});
