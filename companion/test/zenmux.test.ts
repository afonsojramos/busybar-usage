import assert from "node:assert/strict";
import { test } from "node:test";
import { zenmux } from "../src/providers/zenmux.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's zenmux provider test responses.
const payloads = [
  {
    success: true,
    data: {
      plan: { tier: "ultra" },
      account_status: "healthy",
      quota_5_hour: { usage_percentage: 0.0715, max_flows: 800, used_flows: 57.2, remaining_flows: 742.8 },
      quota_7_day: { usage_percentage: 0.0673, max_flows: 6182, used_flows: 416.11, remaining_flows: 5765.89 },
    },
  },
];
const env = { ZENMUX_MANAGEMENT_API_KEY: "fixture-key", ...{} };

test("zenmux: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await zenmux.fetch(context);
  assert.equal(account.provider, "zenmux");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.equal(account.windows[0].used_percent, 7);
  assert.equal(account.windows[1].used_percent, 7);
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fixture-key");
});

test("zenmux: missing credential", async () => {
  await assert.rejects(zenmux.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`zenmux: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status)] });
    const [account] = await zenmux.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("zenmux: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    zenmux.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("zenmux: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({ env, responses: [new Response("fixture-secret-invalid")] });
  await assert.rejects(
    zenmux.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("zenmux: rejects string fractions and malformed envelopes", async () => {
  for (const body of [
    { success: false },
    {
      success: true,
      data: { plan: { tier: "pro" }, account_status: "healthy", quota_5_hour: { usage_percentage: "0.1" } },
    },
  ]) {
    await assert.rejects(zenmux.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  }
});
test("zenmux: exhausted quotas block", async () => {
  const lane = { usage_percentage: 1, max_flows: 100, used_flows: 100, remaining_flows: 0 };
  const [account] = await zenmux.fetch(
    fakeContext({
      env,
      responses: [
        json({
          success: true,
          data: { plan: { tier: "pro" }, account_status: "healthy", quota_5_hour: lane, quota_7_day: lane },
        }),
      ],
    }),
  );
  assert.equal(account.blocked, true);
  assert.deepEqual(
    account.windows.map((w) => w.minutes),
    [300, 10080],
  );
});
