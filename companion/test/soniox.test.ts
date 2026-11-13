import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { soniox } from "../src/providers/soniox.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "SONIOX_ORG_API_KEY": "fixture-key" };
// Synthetic response derived from CodexBar's SonioxPluginTests.
const fixture = { "available_balance_usd": "18.50", "invoice_billing_enabled": false };
const monthly = { month: "2026-11", usage_usd: "6.00", monthly_budget_usd: "100.00" };

test("soniox: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture), json(monthly)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await soniox.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "soniox");
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows.map(w => String(w.used_percent ?? w.value)), ["6", "$18.50"]);
  assert.ok(account.windows.every(w => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["authorization"], "Bearer fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://api.soniox.com");
  assert.equal(context.calls[0]?.url, "https://api.soniox.com/v1/organization/balance");
  assert.equal(context.runs.length, 0);
});

test("soniox: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(soniox.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("soniox: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({ env, responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })] });
    if (status === 401 || status === 403) {
      assert.equal((await soniox.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(soniox.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(soniox.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("soniox: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(soniox.fetch(context), (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"));
  }
});

test("soniox: monthly request errors and invoice billing", async () => {
  for (const status of [401, 403, 429, 500]) {
    const context = fakeContext({ env, responses: [json(fixture), json({}, status)] });
    if (status === 401 || status === 403) assert.equal((await soniox.fetch(context))[0]?.error, "sign in");
    else await assert.rejects(soniox.fetch(context), status === 429 ? RateLimited : HttpError);
  }
  const context = fakeContext({ env, responses: [json({ ...fixture, invoice_billing_enabled: true }), json({ ...monthly, monthly_budget_usd: "0" })] });
  assert.equal((await soniox.fetch(context))[0]?.windows[0]?.value, "$6.00");
});

test("soniox: invalid monthly data and prepaid fields fail safely", async () => {
  for (const fields of [{ usage_usd: -1 }, { monthly_budget_usd: null }, { month: "2026-13" }]) await assert.rejects(soniox.fetch(fakeContext({ env, responses: [json(fixture), json({ ...monthly, ...fields })] })), HttpError);
  await assert.rejects(soniox.fetch(fakeContext({ env, responses: [json({ ...fixture, available_balance_usd: 18.5 })] })), HttpError);
});

test("soniox: companion and CodexBar saved API keys", async () => {
  const entry = { id: "soniox", apiKey: "saved-key" };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { soniox: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture), json(monthly)] });
    await soniox.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some(value => value.includes("saved-key")));
  }
});
