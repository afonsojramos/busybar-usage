import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { cosmic } from "../src/providers/cosmic.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "COSMIC_TOKEN": "fixture-key", "COSMIC_PROJECT_ID": "project &test" };
// Synthetic response derived from CodexBar's CosmicAIPluginTests.
const fixture = { "usage": { "ai": { "input_tokens": 75000, "output_tokens": 150000 } }, "plan_info": { "ai_tokens": { "max_input": "300k", "max_output": "1.5M" } } };

test("cosmic: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await cosmic.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "cosmic");
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows.map(w => String(w.used_percent ?? w.value)), ["25", "10"]);
  assert.ok(account.windows.every(w => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["authorization"], "Bearer fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://dapi.cosmicjs.com");
  assert.equal(context.runs.length, 0);
});

test("cosmic: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(cosmic.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("cosmic: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({ env, responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })] });
    if (status === 401 || status === 403) {
      assert.equal((await cosmic.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(cosmic.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(cosmic.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("cosmic: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(cosmic.fetch(context), (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"));
  }
});

test("cosmic: unknown, zero and unlimited allowances are not quota bars", async () => {
  for (const allowance of [null, "0", "unlimited", "unknown"]) {
    const [account] = await cosmic.fetch(fakeContext({ env, responses: [json({ usage: { ai: { input_tokens: 0 } }, plan_info: { ai_tokens: { max_input: allowance } } })] }));
    assert.equal(account?.windows[0]?.value, "0");
    assert.equal(account?.windows[0]?.resets_at, null);
  }
  const [onlyLimit] = await cosmic.fetch(fakeContext({ env, responses: [json({ plan_info: { ai_tokens: { max_input: "300k", max_output: "unlimited" } } })] }));
  assert.deepEqual(onlyLimit?.windows.map(w => w.value), ["300K", "unlimited"]);
  await assert.rejects(cosmic.fetch(fakeContext({ env, responses: [json({ usage: { ai: { input_tokens: "10" } } })] })), HttpError);
  await assert.rejects(cosmic.fetch(fakeContext({ env: { COSMIC_TOKEN: "fixture-key" } })), NotConfigured);
  const context = fakeContext({ env, responses: [json(fixture)] });
  await cosmic.fetch(context);
  assert.equal(context.calls[0]?.headers.origin, "https://app.cosmicjs.com");
  assert.equal(new URL(context.calls[0]!.url).searchParams.get("project_id"), env.COSMIC_PROJECT_ID);
});

test("cosmic: companion and CodexBar saved API keys", async () => {
  const entry = { id: "cosmic", apiKey: "saved-key", workspaceID: "scope-fixture" };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { cosmic: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture)] });
    await cosmic.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some(value => value.includes("saved-key")));
  }
});
