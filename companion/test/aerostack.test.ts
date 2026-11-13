import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { aerostack } from "../src/providers/aerostack.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { AEROSTACK_TOKEN: "fixture-key" };
// Synthetic response derived from CodexBar's AerostackPluginTests.
const fixture = { period: "2026-03", tier: "free", usage: { ai_tokens: { used: 150000, limit: 1000000 } } };

test("aerostack: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await aerostack.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "aerostack");
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => String(w.used_percent ?? w.value)),
    ["15"],
  );
  assert.ok(account.windows.every((w) => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["authorization"], "Bearer fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://api.aerostack.dev");
  assert.equal(context.calls[0]?.url, "https://api.aerostack.dev/api/billing/usage");
  assert.equal(context.runs.length, 0);
});

test("aerostack: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(aerostack.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("aerostack: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({
      env,
      responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })],
    });
    if (status === 401 || status === 403) {
      assert.equal((await aerostack.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(aerostack.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(aerostack.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("aerostack: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(
      aerostack.fetch(context),
      (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"),
    );
  }
});

test("aerostack: absent and zero allowances preserve counters", async () => {
  for (const tokens of [{ used: 0 }, { used: 10, limit: 0 }, { limit: 100 }]) {
    const [account] = await aerostack.fetch(fakeContext({ env, responses: [json({ usage: { ai_tokens: tokens } })] }));
    assert.equal(account?.windows[0]?.used_percent, null);
  }
  const [full] = await aerostack.fetch(
    fakeContext({ env, responses: [json({ usage: { ai_tokens: { used: 120, limit: 100 } } })] }),
  );
  assert.equal(full?.blocked, true);
  for (const used of [-1, "12", 0.5])
    await assert.rejects(
      aerostack.fetch(fakeContext({ env, responses: [json({ usage: { ai_tokens: { used } } })] })),
      HttpError,
    );
});

test("aerostack: companion and CodexBar saved API keys", async () => {
  const entry = { id: "aerostack", apiKey: "saved-key" };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { aerostack: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture)] });
    await aerostack.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some((value) => value.includes("saved-key")));
  }
});
