import assert from "node:assert/strict";
import { test } from "node:test";
import { neuralwatt } from "../src/providers/neuralwatt.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's neuralwatt provider test responses.
const payloads = [
  {
    balance: { credits_remaining_usd: 12.4, total_credits_usd: 100 },
    subscription: {
      plan: "pro",
      kwh_included: 100,
      kwh_used: 25,
      current_period_start: "2026-11-01T00:00:00Z",
      current_period_end: "2026-12-01T00:00:00Z",
    },
  },
];
const env = { NEURALWATT_API_KEY: "fixture-key", ...{} };

test("neuralwatt: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await neuralwatt.fetch(context);
  assert.equal(account.provider, "neuralwatt");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.equal(account.windows[0].used_percent, 25);
  assert.match(account.windows[1].value ?? "", new RegExp("12\\.40"));
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fixture-key");
});

test("neuralwatt: missing credential", async () => {
  await assert.rejects(neuralwatt.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`neuralwatt: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status)] });
    const [account] = await neuralwatt.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("neuralwatt: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    neuralwatt.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("neuralwatt: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({ env, responses: [new Response("fixture-secret-invalid")] });
  await assert.rejects(
    neuralwatt.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("neuralwatt: derived balance and allowance without subscription", async () => {
  const [account] = await neuralwatt.fetch(
    fakeContext({
      env,
      responses: [
        json({
          balance: { total_credits_usd: 20, credits_used_usd: 5 },
          subscription: null,
          key: { allowance: { limit_usd: 10, spent_usd: 10, period: "monthly" } },
        }),
      ],
    }),
  );
  assert.equal(account.windows[0].name, "key");
  assert.equal(account.windows[0].used_percent, 100);
  assert.equal(account.windows[1].value, "$15.00");
  assert.equal(account.blocked, true);
});
test("neuralwatt: kWh derives consumption and unknown duration retains reset", async () => {
  const [account] = await neuralwatt.fetch(
    fakeContext({
      env,
      responses: [
        json({
          balance: { credits_remaining_usd: 0 },
          subscription: { kwh_included: 100, kwh_remaining: 80, current_period_end: "2027-01-01T00:00:00Z" },
        }),
      ],
    }),
  );
  assert.equal(account.windows[0].used_percent, 20);
  assert.equal(account.windows[0].minutes, null);
  assert.equal(account.windows[0].name, "kWh");
  assert.equal(account.blocked, false);
});
test("neuralwatt: unknown kWh consumption does not invent zero usage", async () => {
  const [account] = await neuralwatt.fetch(
    fakeContext({
      env,
      responses: [json({ balance: { credits_remaining_usd: 12 }, subscription: { kwh_included: 100 } })],
    }),
  );
  assert.equal(account.windows.length, 1);
  assert.equal(account.windows[0].value, "$12.00");
});
for (const body of [
  { balance: {} },
  { balance: { credits_remaining_usd: "12" } },
  { balance: { credits_remaining_usd: 12 }, subscription: { kwh_used: "oops" } },
  { balance: { credits_remaining_usd: 12 }, key: { allowance: { blocked: "true" } } },
])
  test("neuralwatt: rejects invalid quota shape", async () => {
    await assert.rejects(neuralwatt.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  });
