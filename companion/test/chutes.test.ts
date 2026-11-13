import assert from "node:assert/strict";
import { test } from "node:test";
import { chutes } from "../src/providers/chutes.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's chutes provider test responses.
const payloads = [
  {
    subscription: { active: true, plan_name: "Pro" },
    monthly: { used: 250, limit: 1000 },
    rolling_window: { requests: 40, limit: 100, window_minutes: 240 },
  },
];
const env = { CHUTES_API_KEY: "fixture-key", ...{} };

test("chutes: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await chutes.fetch(context);
  assert.equal(account.provider, "chutes");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.equal(account.windows[0].used_percent, 40);
  assert.equal(account.windows[1].used_percent, 25);
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fixture-key");
});

test("chutes: missing credential", async () => {
  await assert.rejects(chutes.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`chutes: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status)] });
    const [account] = await chutes.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("chutes: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    chutes.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("chutes: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({ env, responses: [new Response("fixture-secret-invalid")] });
  await assert.rejects(
    chutes.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("chutes: quota detail fallback merges definition and usage", async () => {
  const context = fakeContext({
    env,
    responses: [
      json({ subscription: { active: false } }),
      json({ quotas: [{ chute_id: "model/id", label: "rolling", limit: 100, window_hours: 4 }] }),
      json({ data: { used: 50 } }),
    ],
  });
  const [account] = await chutes.fetch(context);
  assert.equal(account.windows[0].used_percent, 50);
  assert.equal(account.windows[0].minutes, 240);
  assert.match(context.calls[2].url, /quota_usage\/model%2Fid/);
});
test("chutes: valid no-data payload survives optional failure", async () => {
  const [account] = await chutes.fetch(fakeContext({ env, responses: [json({}), json({}, 503)] }));
  assert.deepEqual(account.windows, []);
});
test("chutes: fractional percentages, remaining quota and durations", async () => {
  const [account] = await chutes.fetch(
    fakeContext({
      env,
      responses: [
        json({
          rolling: { percent_remaining: "0.25", window: "4hours", reset_at: (NOW + 3600) * 1000 },
          monthly: { used: "250", remaining: "750", period_days: 30 },
        }),
      ],
    }),
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [75, 25],
  );
  assert.equal(account.windows[0].resets_at, NOW + 3600);
});
test("chutes: optional auth rejection is sign in", async () => {
  const [account] = await chutes.fetch(fakeContext({ env, responses: [json({}), json({}, 401)] }));
  assert.equal(account.error, "sign in");
});
for (const raw of ["https://attacker.example", "http://api.chutes.ai", "https://api.chutes.ai@attacker.example"])
  test("chutes: override cannot leak key", async () => {
    const context = fakeContext({ env: { ...env, CHUTES_API_URL: raw } });
    await assert.rejects(chutes.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  });
