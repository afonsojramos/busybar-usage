import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { traecn } from "../src/providers/traecn.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic response shapes from CodexBar's provider plugin tests.
const fixture = [
  { Result: { Token: "fake-jwt" } },
  { is_credits_billing: true, usage_summary: { total_amount: 10000, consumed_amount: 2000 } },
];
const cookie = "sessionid=fixture-session";
function configured(responses = fixture.map((body) => json(body)), entry: Record<string, unknown> = {}) {
  return fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: {
          traecn: { cookieHeader: cookie, ...entry },
        },
      }),
    },
    responses,
  });
}

test("traecn maps the CodexBar fixture", async () => {
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
  const [account] = await traecn.fetch(context);
  assert.equal(account.windows[0].used_percent, 20);
  assert.equal(account.windows[0].resets_at, null);
  assert.equal(context.calls[1].headers.authorization, "Cloud-IDE-JWT fake-jwt");
  assert.equal(account.provider, "traecn");
  assert.ok(account.windows.length <= 2);
  assert.ok(account.windows.every((w) => w.value === undefined || w.value.length <= 12));
  assert.ok(context.calls.every((c) => c.url.startsWith("https://")));
  assert.equal(context.calls[0].headers.cookie, cookie);
});

test("traecn skips a missing session", async () => {
  const context = fakeContext({});
  await assert.rejects(traecn.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("traecn honors disabled cookies", async () => {
  const context = configured([], { cookieSource: "off" });
  await assert.rejects(traecn.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

for (const status of [401, 403])
  test(`traecn maps HTTP ${status} to sign in`, async () => {
    const [account] = await traecn.fetch(configured([json({ private: "never include" }, status)]));
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("traecn honors Retry-After", async () => {
  await assert.rejects(
    traecn.fetch(configured([json({}, 429, { "retry-after": "17" })])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 17,
  );
  await assert.rejects(
    traecn.fetch(configured([json({}, 429)])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300,
  );
});

test("traecn rejects malformed bodies and failed HTTP without leaking data", async () => {
  for (const response of [new Response("fake-private-token", { status: 200 }), json({}, 500), json(null)]) {
    await assert.rejects(
      traecn.fetch(configured([response])),
      (error: unknown) => error instanceof HttpError && !error.message.includes("fake-private-token"),
    );
  }
});

test("traecn handles rejected exchange, non-credit billing and zero or fractional allowance", async () => {
  const login = json(fixture[0]);
  const [expired] = await traecn.fetch(configured([login, json({ code: 1001 })]));
  assert.equal(expired.error, "sign in");
  for (const [total, used] of [
    [0, 0],
    [10.5, 1.5],
    [10, 12],
  ]) {
    const [account] = await traecn.fetch(
      configured([
        json(fixture[0]),
        json({ is_credits_billing: true, usage_summary: { total_amount: total, consumed_amount: used } }),
      ]),
    );
    assert.equal(account.blocked, used >= total);
    assert.equal(account.windows[0].resets_at, null);
  }
  for (const summary of [
    { total_amount: -1, consumed_amount: 0 },
    { total_amount: "1", consumed_amount: 0 },
  ])
    await assert.rejects(
      traecn.fetch(configured([json(fixture[0]), json({ is_credits_billing: true, usage_summary: summary })])),
      HttpError,
    );
  await assert.rejects(traecn.fetch(configured([json({ Result: { Token: "" } })])), HttpError);
  await assert.rejects(traecn.fetch(configured([json(fixture[0]), json({ is_credits_billing: false })])), HttpError);
});
