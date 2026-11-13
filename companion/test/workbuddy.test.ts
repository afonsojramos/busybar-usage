import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { workbuddy } from "../src/providers/workbuddy.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic response shapes from CodexBar's provider plugin tests.
const fixture = [{"code": 0, "data": {"Packages": [{"CycleTotalCapacity": "500", "CycleRemainCapacity": "450", "CycleFrozenCapacity": "0", "CapacityUnit": "credits"}], "SubscriptionPackageName": "体验版"}}, {"code": 0, "data": {"Accounts": []}}, {"code": 0, "data": {"Accounts": [{"CapacityUnit": "credits", "CycleEndTime": "2026-12-31 23:59:59"}]}}];
const cookie = "session=fixture-session; locale=zh";
function configured(responses = fixture.map(body => json(body)), entry: Record<string, unknown> = {}) {
  return fakeContext({ files: {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: {
      workbuddy: { cookieHeader: cookie, ...entry },
    } }),
  }, responses });
}

test("workbuddy maps the CodexBar fixture", async () => {
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
  const [account] = await workbuddy.fetch(context);
  assert.equal(account.windows[0].used_percent, 10);
  assert.equal(account.windows[0].resets_at, Date.parse("2027-01-01T00:00:00+08:00") / 1000);
  assert.equal(account.provider, "workbuddy");
  assert.ok(account.windows.length <= 2);
  assert.ok(account.windows.every(w => w.value === undefined || w.value.length <= 12));
  assert.ok(context.calls.every(c => c.url.startsWith("https://")));
  assert.equal(context.calls[0].headers.cookie, cookie);
});

test("workbuddy skips a missing session", async () => {
  const context = fakeContext({});
  await assert.rejects(workbuddy.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("workbuddy honors disabled cookies", async () => {
  const context = configured([], { cookieSource: "off" });
  await assert.rejects(workbuddy.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

for (const status of [401, 403]) test(`workbuddy maps HTTP ${status} to sign in`, async () => {
  const [account] = await workbuddy.fetch(configured([json({ private: "never include" }, status)]));
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("workbuddy honors Retry-After", async () => {
  await assert.rejects(workbuddy.fetch(configured([json({}, 429, { "retry-after": "17" })])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 17);
  await assert.rejects(workbuddy.fetch(configured([json({}, 429)])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300);
});

test("workbuddy rejects malformed bodies and failed HTTP without leaking data", async () => {
  for (const response of [new Response("fake-private-token", { status: 200 }), json({}, 500), json(null)]) {
    await assert.rejects(workbuddy.fetch(configured([response])), (error: unknown) =>
      error instanceof HttpError && !error.message.includes("fake-private-token"));
  }
});

test("workbuddy optional listings preserve totals and rewards are a second lane", async () => {
  const [account] = await workbuddy.fetch(configured([json({ code: 0, data: { Packages: [
    { CapacityUnit: "credits", CycleTotalCapacity: "500", CycleRemainCapacity: "600" },
    { CapacityUnit: "tokens", CycleTotalCapacity: "invalid" },
  ], CreditGroups: [{ Kind: "benefit", CapacityUnit: "credits", CycleTotalCapacity: "200", CycleRemainCapacity: "100" },
    { Kind: "benefit", CapacityUnit: "credits", CycleTotalCapacity: "invalid" }] } }), json({}, 500), json({}, 401)]));
  assert.deepEqual(account.windows.map(w => w.used_percent), [0, 50]);
  assert.equal(account.windows[0].resets_at, null);
});

test("workbuddy reconstructs Chrome UA and retries the previous major only on 401", async () => {
  const context = configured([json({}, 401), ...fixture.map(body => json(body))]);
  context.platform = "darwin";
  const read = context.readFile;
  context.readFile = async file => file === "/Applications/Google Chrome.app/Contents/Info.plist"
    ? "<key>CFBundleShortVersionString</key><string>154.0.0.0</string>" : read(file);
  await workbuddy.fetch(context);
  assert.match(context.calls[0].headers["user-agent"], /Chrome\/154\./);
  assert.match(context.calls[1].headers["user-agent"], /Chrome\/153\./);
  const manual = configured(undefined, { cookieSource: "manual", workBuddyUserAgent: "Synthetic/1" });
  await workbuddy.fetch(manual);
  assert.equal(manual.calls[0].headers["user-agent"], "Synthetic/1");
  const invalid = configured([], { cookieSource: "manual", workBuddyUserAgent: "evil\nheader" });
  await assert.rejects(workbuddy.fetch(invalid), NotConfigured);
  assert.equal(invalid.calls.length, 0);
});

test("workbuddy rejects negative credits and nonzero API code, and supports zero total", async () => {
  for (const body of [{ code: 1, data: {} }, { code: 0, data: { Packages: [{ CapacityUnit: "credits",
    CycleTotalCapacity: "-1", CycleRemainCapacity: "0" }] } }])
    await assert.rejects(workbuddy.fetch(configured([json(body)])), HttpError);
  const [account] = await workbuddy.fetch(configured([json({ code: 0, data: { Packages: [
    { CapacityUnit: "credits", CycleTotalCapacity: 0, CycleRemainCapacity: 0 },
  ] } }), json({}, 500), json({}, 500)]));
  assert.equal(account.windows[0].value, "0 cr");
});
