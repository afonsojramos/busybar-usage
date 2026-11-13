import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { futureagi } from "../src/providers/futureagi.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "FI_API_KEY": "fixture-key", "FI_SECRET_KEY": "fixture-secret" };
// Synthetic response derived from CodexBar's FutureAGIPluginTests.
const fixture = { "status": true, "result": { "billing_period_start": "2026-11-01", "billing_period_end": "2026-12-01", "total_estimated_cost": 1.25, "dimensions": [{ "key": "ai_credits", "display_name": "AI credits", "display_unit": "credits", "current_usage": 500, "free_allowance": 2000 }, { "key": "gateway_requests", "display_name": "Gateway requests", "display_unit": "requests", "current_usage": 150000, "free_allowance": 100000 }] } };

test("futureagi: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await futureagi.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "futureagi");
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows.map(w => String(w.used_percent ?? w.value)), ["25", "100"]);
  assert.ok(account.windows.every(w => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["x-api-key"], "fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://api.futureagi.com");
  assert.equal(context.calls[0]?.url, "https://api.futureagi.com/usage/v2/usage-overview/");
  assert.equal(context.runs.length, 0);
});

test("futureagi: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(futureagi.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("futureagi: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({ env, responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })] });
    if (status === 401 || status === 403) {
      assert.equal((await futureagi.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(futureagi.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(futureagi.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("futureagi: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(futureagi.fetch(context), (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"));
  }
});

test("futureagi: credential pairs and saved secret", async () => {
  await assert.rejects(futureagi.fetch(fakeContext({ env: { FI_API_KEY: "fixture-key" } })), NotConfigured);
  const context = fakeContext({ files: { "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [{ id: "futureagi", apiKey: "fixture-key", pluginSecrets: { FI_SECRET_KEY: "fixture-secret" } }] }) }, responses: [json(fixture)] });
  await futureagi.fetch(context);
  assert.equal(context.calls[0]?.headers["x-secret-key"], "fixture-secret");
});

test("futureagi: zero allowance is a value and duplicate meters fail", async () => {
  const result = { ...fixture.result, dimensions: fixture.result.dimensions.map(meter => ({ ...meter, free_allowance: 0 })) };
  const [account] = await futureagi.fetch(fakeContext({ env, responses: [json({ status: true, result })] }));
  assert.deepEqual(account?.windows.map(w => w.used_percent), [null, null]);
  for (const dimensions of [[], [fixture.result.dimensions[0], fixture.result.dimensions[0]], [{ ...fixture.result.dimensions[0], current_usage: "10" }]]) await assert.rejects(futureagi.fetch(fakeContext({ env, responses: [json({ status: true, result: { ...result, dimensions } })] })), HttpError);
});

test("futureagi: companion and CodexBar saved API keys", async () => {
  const entry = { id: "futureagi", apiKey: "saved-key", pluginSecrets: { FI_SECRET_KEY: "fixture-secret" } };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { futureagi: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture)] });
    await futureagi.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some(value => value.includes("saved-key")));
  }
});
