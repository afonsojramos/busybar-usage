import assert from "node:assert/strict";
import { test } from "node:test";
import { sofya } from "../src/providers/sofya.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "SOFYA_API_KEY": "fixture-key" };
// Synthetic response derived from CodexBar's SofyaPluginTests.
const fixture = { "credits": 1034, "plan_credits": 997, "purchased_credits": 37, "is_free_tier": true, "credits_reset_at": "2026-11-04T12:00:00Z" };

test("sofya: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await sofya.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "sofya");
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows.map(w => String(w.used_percent ?? w.value)), ["997 cr", "37 cr"]);
  assert.ok(account.windows.every(w => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["authorization"], "Bearer fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://sofya.co");
  assert.equal(context.calls[0]?.url, "https://sofya.co/v1/auth/me");
  assert.equal(context.runs.length, 0);
});

test("sofya: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(sofya.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("sofya: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({ env, responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })] });
    if (status === 401 || status === 403) {
      assert.equal((await sofya.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(sofya.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(sofya.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("sofya: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(sofya.fetch(context), (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"));
  }
});

test("sofya: partial credits, zero balances and reset validation", async () => {
  const [partial] = await sofya.fetch(fakeContext({ env, responses: [json({ purchased_credits: 37, plan_credits: null, credits_reset_at: null })] }));
  assert.equal(partial?.windows[0]?.value, "37 cr");
  const [zero] = await sofya.fetch(fakeContext({ env, responses: [json({ credits: 0, is_free_tier: false, credits_reset_at: fixture.credits_reset_at })] }));
  assert.equal(zero?.blocked, true);
  assert.equal(zero?.windows[0]?.resets_at, null);
  const [email] = await sofya.fetch(fakeContext({ env, responses: [json({ ...fixture, email: "person@example.test" })] }));
  assert.equal(email?.account, "example");
  for (const fields of [{ credits: "1" }, { plan_credits: -1 }, { credits_reset_at: "2026-02-31T12:00:00Z" }, { is_free_tier: "true" }]) await assert.rejects(sofya.fetch(fakeContext({ env, responses: [json({ ...fixture, ...fields })] })), HttpError);
});

test("sofya: companion and CodexBar saved API keys", async () => {
  const entry = { id: "sofya", apiKey: "saved-key" };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { sofya: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture)] });
    await sofya.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some(value => value.includes("saved-key")));
  }
});
