import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { langdock } from "../src/providers/langdock.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic response shapes from CodexBar's provider plugin tests.
const fixture = [[{"result": {"data": {"json": {"hasIncludedUsageLimits": true, "planUsage": {"sessionUsageLimitsEnabled": true, "sessionUsagePercent": 12.5, "sessionResetsAt": "2027-09-25T12:00:00.123Z", "weeklyUsagePercent": 104.2, "weeklyResetsAt": "2027-09-28T12:00:00Z"}}}}}]];
const cookie = "auth_token=synthetic-account-a";
function configured(responses = fixture.map(body => json(body)), entry: Record<string, unknown> = {}) {
  return fakeContext({ files: {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: {
      langdock: { cookieHeader: cookie, ...entry },
    } }),
  }, responses });
}

test("langdock maps the CodexBar fixture", async () => {
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
  const [account] = await langdock.fetch(context);
  assert.deepEqual(account.windows.map(w => [w.minutes, w.used_percent]), [[300, 13], [10080, 100]]);
  assert.equal(account.blocked, true);
  assert.equal(account.provider, "langdock");
  assert.ok(account.windows.length <= 2);
  assert.ok(account.windows.every(w => w.value === undefined || w.value.length <= 12));
  assert.ok(context.calls.every(c => c.url.startsWith("https://")));
  assert.equal(context.calls[0].headers.cookie, cookie);
});

test("langdock skips a missing session", async () => {
  const context = fakeContext({});
  await assert.rejects(langdock.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("langdock honors disabled cookies", async () => {
  const context = configured([], { cookieSource: "off" });
  await assert.rejects(langdock.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

for (const status of [401, 403]) test(`langdock maps HTTP ${status} to sign in`, async () => {
  const [account] = await langdock.fetch(configured([json({ private: "never include" }, status)]));
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("langdock honors Retry-After", async () => {
  await assert.rejects(langdock.fetch(configured([json({}, 429, { "retry-after": "17" })])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 17);
  await assert.rejects(langdock.fetch(configured([json({}, 429)])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300);
});

test("langdock rejects malformed bodies and failed HTTP without leaking data", async () => {
  for (const response of [new Response("fake-private-token", { status: 200 }), json({}, 500), json(null)]) {
    await assert.rejects(langdock.fetch(configured([response])), (error: unknown) =>
      error instanceof HttpError && !error.message.includes("fake-private-token"));
  }
});

const envelope = (payload: unknown) => json([{ result: { data: { json: payload } } }]);
test("langdock handles weekly only and absent included limits", async () => {
  const [weekly] = await langdock.fetch(configured([envelope({ planUsage: { sessionUsageLimitsEnabled: false, weeklyUsagePercent: 0 } })]));
  assert.deepEqual(weekly.windows.map(w => [w.name, w.used_percent, w.resets_at]), [["7d", 0, null]]);
  for (const payload of [{ hasIncludedUsageLimits: false }, { planUsage: null }]) {
    const [account] = await langdock.fetch(configured([envelope(payload)]));
    assert.equal(account.windows[0].value, "none");
  }
  for (const plan of [{ sessionUsageLimitsEnabled: false, weeklyUsagePercent: "4" },
    { sessionUsageLimitsEnabled: false, weeklyUsagePercent: 4, weeklyResetsAt: "tomorrow" },
    { sessionUsageLimitsEnabled: true, weeklyUsagePercent: 4 }])
    await assert.rejects(langdock.fetch(configured([envelope({ planUsage: plan })])), HttpError);
});

test("langdock maps tRPC errors", async () => {
  for (const code of ["UNAUTHORIZED", "FORBIDDEN", "TOO_MANY_REQUESTS", "INTERNAL_SERVER_ERROR", 403]) {
    const response = json([{ error: { json: { data: { code } } } }]);
    if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
      const [account] = await langdock.fetch(configured([response]));
      assert.equal(account.error, "sign in");
    } else await assert.rejects(langdock.fetch(configured([response])), code === "TOO_MANY_REQUESTS" ? RateLimited : HttpError);
  }
});
