import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { zoommate } from "../src/providers/zoommate.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic response shapes from CodexBar's provider plugin tests.
const fixture = [{"data": {"nak": "opaque-fixture", "user_profile": {"email": "fixture@example.test"}}}, {"data": {"credit_status": {"budget_cap": 1000, "used_credit": 250, "cycle_start_date": 1799000000000, "cycle_end_date": 1801000000000}}}];
const cookie = "session=synthetic";
function configured(responses = fixture.map(body => json(body)), entry: Record<string, unknown> = {}) {
  return fakeContext({ files: {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: {
      zoommate: { cookieHeader: cookie, ...entry },
    } }),
  }, responses });
}

test("zoommate maps the CodexBar fixture", async () => {
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
  const [account] = await zoommate.fetch(context);
  assert.equal(account.windows[0].used_percent, 25);
  assert.equal(account.account, "example");
  assert.equal(context.calls[1].headers.authorization, "Bearer opaque-fixture");
  assert.equal(account.provider, "zoommate");
  assert.ok(account.windows.length <= 2);
  assert.ok(account.windows.every(w => w.value === undefined || w.value.length <= 12));
  assert.ok(context.calls.every(c => c.url.startsWith("https://")));
  assert.equal(context.calls[0].headers.cookie, cookie);
});

test("zoommate skips a missing session", async () => {
  const context = fakeContext({});
  await assert.rejects(zoommate.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("zoommate honors disabled cookies", async () => {
  const context = configured([], { cookieSource: "off" });
  await assert.rejects(zoommate.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

for (const status of [401, 403]) test(`zoommate maps HTTP ${status} to sign in`, async () => {
  const [account] = await zoommate.fetch(configured([json({ private: "never include" }, status)]));
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("zoommate honors Retry-After", async () => {
  await assert.rejects(zoommate.fetch(configured([json({}, 429, { "retry-after": "17" })])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 17);
  await assert.rejects(zoommate.fetch(configured([json({}, 429)])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300);
});

test("zoommate rejects malformed bodies and failed HTTP without leaking data", async () => {
  for (const response of [new Response("fake-private-token", { status: 200 }), json({}, 500), json(null)]) {
    await assert.rejects(zoommate.fetch(configured([response, response.clone()])), (error: unknown) =>
      error instanceof HttpError && !error.message.includes("fake-private-token"));
  }
});

test("zoommate manual capture stays on first-party hosts and forwards only allowed headers", async () => {
  const capture = "curl 'https://zoommate.zoom.us/ai-computer/api/v1/credits/status' -H 'Authorization: Bearer fake-manual' -H 'Cookie: hostonly=fake' -H 'Origin: https://evil.test' -H 'X-Evil: ignored'";
  const context = configured([json(fixture[1])], { cookieSource: "manual", cookieHeader: capture });
  await zoommate.fetch(context);
  assert.match(context.calls[0].url, /^https:\/\/zoommate.zoom.us\//);
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-manual");
  assert.equal(context.calls[0].headers.cookie, "hostonly=fake");
  assert.equal(context.calls[0].headers.origin, "https://zoommate.zoom.us");
  assert.equal(context.calls[0].headers["x-evil"], undefined);
  for (const url of ["http://ai.zoom.us/ai-computer/api/v1/credits/status", "https://evil.test/ai-computer/api/v1/credits/status",
    "https://ai.zoom.us/other", "https://user@ai.zoom.us/ai-computer/api/v1/credits/status"]) {
    const ctx = configured([], { cookieSource: "manual", cookieHeader: `curl '${url}' -H 'Authorization: Bearer fake'` });
    await assert.rejects(zoommate.fetch(ctx), NotConfigured);
    assert.equal(ctx.calls.length, 0);
  }
});

test("zoommate fails over without forwarding cookies to the sibling", async () => {
  const context = configured([json({}, 500), json(fixture[0]), json(fixture[1])]);
  await zoommate.fetch(context);
  assert.match(context.calls[1].url, /^https:\/\/zoommate.zoom.us\//);
  assert.equal(context.calls[1].headers.cookie, undefined);
  assert.equal(context.calls[2].headers.authorization, "Bearer opaque-fixture");
});

test("zoommate unlimited quota and malformed optional fields", async () => {
  const [account] = await zoommate.fetch(configured([json(fixture[0]), json({ data: { credit_status: {
    budget_cap: 0, used_credit: 50, is_unlimited: true,
  } } })]));
  assert.equal(account.windows[0].value, "unlimited");
  for (const status of [{ budget_cap: "10" }, { is_unlimited: "true" }, { cycle_end_date: 1.5 }])
    await assert.rejects(zoommate.fetch(configured([json(fixture[0]), json({ data: { credit_status: status } })])), HttpError);
});
