import assert from "node:assert/strict";
import { test } from "node:test";
import { linkup } from "../src/providers/linkup.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "LINKUP_API_KEY": "fixture-key" };
// Synthetic response derived from CodexBar's LinkupPluginTests.
const fixture = { "balance": 123.456 };

test("linkup: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await linkup.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "linkup");
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows.map(w => String(w.used_percent ?? w.value)), ["$123.46"]);
  assert.ok(account.windows.every(w => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["authorization"], "Bearer fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://api.linkup.so");
  assert.equal(context.calls[0]?.url, "https://api.linkup.so/v1/credits/balance");
  assert.equal(context.runs.length, 0);
});

test("linkup: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(linkup.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("linkup: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({ env, responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })] });
    if (status === 401 || status === 403) {
      assert.equal((await linkup.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(linkup.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(linkup.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("linkup: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(linkup.fetch(context), (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"));
  }
});

test("linkup: zero, negative and large balances retain bounded values", async () => {
  for (const balance of [0, -1, 1e200]) {
    const [account] = await linkup.fetch(fakeContext({ env, responses: [json({ balance })] }));
    assert.equal(account?.windows[0]?.used_percent, null);
    assert.ok((account?.windows[0]?.value?.length ?? 100) <= 12);
  }
  await assert.rejects(linkup.fetch(fakeContext({ env, responses: [json({ balance: "1" })] })), HttpError);
});

test("linkup: companion and CodexBar saved API keys", async () => {
  const entry = { id: "linkup", apiKey: "saved-key" };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { linkup: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture)] });
    await linkup.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some(value => value.includes("saved-key")));
  }
});
