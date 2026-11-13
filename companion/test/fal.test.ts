import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { fal } from "../src/providers/fal.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "FAL_KEY": "fixture-key" };
// Synthetic response derived from CodexBar's falPluginTests.
const fixture = { "username": "fixture-team", "credits": { "current_balance": 42.5, "currency": "USD" } };

test("fal: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await fal.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "fal");
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows.map(w => String(w.used_percent ?? w.value)), ["$42.50"]);
  assert.ok(account.windows.every(w => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["authorization"], "Key fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://api.fal.ai");
  assert.equal(context.calls[0]?.url, "https://api.fal.ai/v1/account/billing?expand=credits");
  assert.equal(context.runs.length, 0);
});

test("fal: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(fal.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("fal: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({ env, responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })] });
    if (status === 401 || status === 403) {
      assert.equal((await fal.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(fal.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(fal.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("fal: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(fal.fetch(context), (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"));
  }
});

test("fal: string balance and currency fallback", async () => {
  for (const [balance, currency, expected] of [["12.75", "USD", "$12.75"], [0, "USD", "$0.00"], [-1, "EUR", "-€1.00"], [3, "bad", "$3.00"]]) {
    const [account] = await fal.fetch(fakeContext({ env, responses: [json({ credits: { current_balance: balance, currency } })] }));
    assert.equal(account?.windows[0]?.value, expected);
  }
  for (const credits of [null, {}, { current_balance: "1e3" }, { current_balance: true }]) await assert.rejects(fal.fetch(fakeContext({ env, responses: [json({ credits })] })), HttpError);
});

test("fal: companion and CodexBar saved API keys", async () => {
  const entry = { id: "fal", apiKey: "saved-key" };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { fal: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture)] });
    await fal.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some(value => value.includes("saved-key")));
  }
});

test("fal: very large negative balances fit the display", async () => {
  const [account] = await fal.fetch(fakeContext({ env, responses: [json({ credits: { current_balance: -1.7e308, currency: "EUR" } })] }));
  assert.ok((account?.windows[0]?.value?.length ?? 100) <= 12);
});
