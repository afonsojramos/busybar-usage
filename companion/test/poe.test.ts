import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { poe } from "../src/providers/poe.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's poe provider test responses.
const payloads = [{ current_point_balance: 1500 }, { data: [], next_cursor: null }];
const env = { POE_API_KEY: "fixture-key", ...{} };

test("poe: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await poe.fetch(context);
  assert.equal(account.provider, "poe");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.match(account.windows[0].value ?? "", new RegExp("1\\.5K"));
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fixture-key");
});

test("poe: missing credential", async () => {
  await assert.rejects(poe.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`poe: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status)] });
    const [account] = await poe.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("poe: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    poe.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("poe: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({ env, responses: [new Response("fixture-secret-invalid")] });
  await assert.rejects(
    poe.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("poe: history pagination and invalid dates", async () => {
  const context = fakeContext({
    env,
    responses: [
      json({ current_point_balance: "2500" }),
      json({
        data: [
          { creation_time: NOW, cost_points: 100 },
          { timestamp: "invalid", points: 10000 },
          { timestamp: 1e300, points: 10000 },
        ],
        next_cursor: "next",
      }),
      json({ items: [{ created_at: new Date(NOW * 1000).toISOString(), point_cost: "200" }] }),
    ],
  });
  const [account] = await poe.fetch(context);
  assert.equal(account.windows[0].value, "2.5K pt");
  assert.equal(account.windows[1].value, "300 pt");
  assert.match(context.calls[2].url, /starting_after=next/);
});
test("poe: optional history failure preserves zero balance", async () => {
  const [account] = await poe.fetch(
    fakeContext({ env, responses: [json({ current_point_balance: 0 }), json({}, 503)] }),
  );
  assert.equal(account.windows[0].value, "0 pt");
  assert.equal(account.blocked, true);
});
test("poe: absent balance is a valid empty snapshot", async () => {
  const [account] = await poe.fetch(fakeContext({ env, responses: [json({}), json({ data: [] })] }));
  assert.deepEqual(account.windows, []);
});
