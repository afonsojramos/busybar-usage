import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { sailresearch } from "../src/providers/sailresearch.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "SAIL_API_KEY": "fixture-key" };
// Synthetic response derived from CodexBar's SailResearchPluginTests.
const fixture = { "object": "usage.summary", "available": true, "has_metronome_customer": true, "balance_unavailable": false, "balance": 1250, "period_spend": 123.4, "effective_range": "7d" };

test("sailresearch: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await sailresearch.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "sailresearch");
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows.map(w => String(w.used_percent ?? w.value)), ["$12.50", "$1.23"]);
  assert.ok(account.windows.every(w => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["authorization"], "Bearer fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://api.sailresearch.com");
  assert.equal(context.calls[0]?.url, "https://api.sailresearch.com/v2/usage/summary?range=30d");
  assert.equal(context.runs.length, 0);
});

test("sailresearch: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(sailresearch.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("sailresearch: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({ env, responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })] });
    if (status === 401 || status === 403) {
      assert.equal((await sailresearch.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(sailresearch.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(sailresearch.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("sailresearch: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(sailresearch.fetch(context), (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"));
  }
});

test("sailresearch: unavailable balance keeps spend and effective range", async () => {
  const [account] = await sailresearch.fetch(fakeContext({ env, responses: [json({ ...fixture, balance_unavailable: true, balance: null })] }));
  assert.deepEqual(account?.windows.map(w => [w.name, w.value]), [["7d", "$1.23"]]);
  for (const fields of [{ available: false }, { has_metronome_customer: false }, { period_spend: -1 }, { effective_range: "toString" }]) await assert.rejects(sailresearch.fetch(fakeContext({ env, responses: [json({ ...fixture, ...fields })] })), HttpError);
});

test("sailresearch: companion and CodexBar saved API keys", async () => {
  const entry = { id: "sailresearch", apiKey: "saved-key" };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { sailresearch: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture)] });
    await sailresearch.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some(value => value.includes("saved-key")));
  }
});
