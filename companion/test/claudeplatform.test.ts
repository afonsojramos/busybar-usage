import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { claudeplatform } from "../src/providers/claudeplatform.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic response shapes from CodexBar's provider plugin tests.
const fixture = [[{"uuid": "chat", "capabilities": ["chat"]}, {"uuid": "api-org", "capabilities": ["api"]}], {"amount": 18725, "currency": "USD", "balance": {"credits": {"exponent": 2}}, "promo_tranches": [{"remaining_amount_minor_units": 12475, "granted_amount_minor_units": 20000, "expires_at": "2027-10-28T00:00:00Z", "program_id": "subscription_api_credit"}], "tranches": [{"remaining_amount_minor_units": 6250, "granted_amount_minor_units": 10000, "expires_at": "2027-05-01T00:00:00Z"}]}];
const cookie = "sessionKey=fixture-session";
function configured(responses = fixture.map(body => json(body)), entry: Record<string, unknown> = {}) {
  return fakeContext({ files: {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: {
      claudeplatform: { cookieHeader: cookie, ...entry },
    } }),
  }, responses });
}

test("claudeplatform maps the CodexBar fixture", async () => {
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
  const [account] = await claudeplatform.fetch(context);
  assert.equal(account.windows[0].value, "$187.25");
  assert.equal(account.windows[1].used_percent, 38);
  assert.match(context.calls[1].url, /api-org\/prepaid\/credits$/);
  assert.equal(account.provider, "claudeplatform");
  assert.ok(account.windows.length <= 2);
  assert.ok(account.windows.every(w => w.value === undefined || w.value.length <= 12));
  assert.ok(context.calls.every(c => c.url.startsWith("https://")));
  assert.equal(context.calls[0].headers.cookie, cookie);
});

test("claudeplatform skips a missing session", async () => {
  const context = fakeContext({});
  await assert.rejects(claudeplatform.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("claudeplatform honors disabled cookies", async () => {
  const context = configured([], { cookieSource: "off" });
  await assert.rejects(claudeplatform.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

for (const status of [401, 403]) test(`claudeplatform maps HTTP ${status} to sign in`, async () => {
  const [account] = await claudeplatform.fetch(configured([json({ private: "never include" }, status)]));
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("claudeplatform honors Retry-After", async () => {
  await assert.rejects(claudeplatform.fetch(configured([json({}, 429, { "retry-after": "17" })])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 17);
  await assert.rejects(claudeplatform.fetch(configured([json({}, 429)])),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300);
});

test("claudeplatform rejects malformed bodies and failed HTTP without leaking data", async () => {
  for (const response of [new Response("fake-private-token", { status: 200 }), json({}, 500), json(null)]) {
    await assert.rejects(claudeplatform.fetch(configured([response])), (error: unknown) =>
      error instanceof HttpError && !error.message.includes("fake-private-token"));
  }
});

test("claudeplatform tries the next API organization after billing access denied", async () => {
  const context = configured([json([{ uuid: "first", capabilities: ["api"] }, { uuid: "second", capabilities: ["api"] }]),
    json({}, 403), json(fixture[1])]);
  const [account] = await claudeplatform.fetch(context);
  assert.equal(account.windows[0].value, "$187.25");
  assert.match(context.calls[2].url, /second\/prepaid\/credits$/);
});

test("claudeplatform supports currency exponents and selects purchased when promo expired", async () => {
  const [account] = await claudeplatform.fetch(configured([json(fixture[0]), json({ amount: 12345, currency: "EUR",
    balance: { credits: { exponent: 3 } }, promo_tranches: [{ granted_amount_minor_units: 100,
      remaining_amount_minor_units: 25, expires_at: "2020-01-01T00:00:00Z", program_id: "subscription_api_credit" }],
    tranches: [{ granted_amount_minor_units: 100, remaining_amount_minor_units: 0, expires_at: "invalid" }] })]));
  assert.equal(account.windows[0].value, "12.35 EUR");
  assert.equal(account.windows[1].name, "Bought");
  assert.equal(account.windows[1].used_percent, 100);
  for (const credits of [{ amount: "1" }, { amount: 1, balance: { credits: { exponent: 5 } } },
    { amount: 1, tranches: {} }, { amount: 1, currency: "evil" }])
    await assert.rejects(claudeplatform.fetch(configured([json(fixture[0]), json(credits)])), HttpError);
});
