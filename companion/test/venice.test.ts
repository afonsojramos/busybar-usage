import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { venice } from "../src/providers/venice.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const usage = {
  "canConsume": true,
  "consumptionCurrency": "DIEM",
  "balances": {
    "diem": 90.5,
    "usd": 25.75
  },
  "diemEpochAllocation": 100
};
const extras: unknown[] = [];
const env = { VENICE_API_KEY: "fake-api-key" };
const responses = () => [json(usage), ...extras.map((body) => json(body))];

test("Venice: CodexBar-derived fixture and request", async () => {
  const context = fakeContext({ env, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.method ?? "GET", "GET");
    return fetch(input, init);
  };
  const [account] = await venice.fetch(context);
  assert.equal(account.provider, "venice");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.equal(account.blocked, false);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent, w.value ?? null]),
    [["DIEM", 10, null], ["USD", null, "$25.75"]]);
  assert.equal(context.calls[0].url, "https://api.venice.ai/api/v1/billing/balance");
  for (const call of context.calls) {
    assert.equal(call.headers["authorization"], "Bearer fake-api-key");
    assert.equal(call.headers.accept, "application/json");
  }
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});

test("Venice: missing credentials", async () => {
  await assert.rejects(venice.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`Venice: ${status} asks to sign in`, async () => {
    const [account] = await venice.fetch(fakeContext({ env, responses: [json({ secret: "private-body" }, status)] }));
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });
}

for (const retry of [undefined, "120"]) {
  test(`Venice: rate limit ${retry ?? "default"}`, async () => {
    await assert.rejects(venice.fetch(fakeContext({
      env, responses: [json({}, 429, retry ? { "retry-after": retry } : {})],
    })), (error: unknown) => error instanceof RateLimited && error.until === NOW + (retry ? 120 : 300));
  });
}

for (const body of ["private-body", "null", "[]", "{}"] ) {
  test(`Venice: rejects invalid body ${body} safely`, async () => {
    await assert.rejects(venice.fetch(fakeContext({
      env, responses: [new Response(body), ...extras.map((value) => json(value))],
    })), (error: unknown) => error instanceof HttpError && !error.message.includes("private-body"));
  });
}

test("Venice: HTTP errors omit response content", async () => {
  await assert.rejects(venice.fetch(fakeContext({env, responses: [json({ secret: "private-body" }, 503)]})),
    (error: unknown) => error instanceof HttpError && error.status === 503 && !error.message.includes("private-body"));
});

test("Venice: companion config supplies the API key", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { venice: { apiKey: "fake-api-key" } } }) },
    responses: responses(),
  });
  assert.equal((await venice.fetch(context))[0].windows.length, 2);
});

test("Venice: USD wallet never becomes a percentage",async () => {
  const [account] = await venice.fetch(fakeContext({env,responses:[json({canConsume:true,consumptionCurrency:"USD",balances:{diem:null,usd:25.75}})]}));
  assert.equal(account.windows[0].value,"$25.75");
  assert.equal(account.windows[0].used_percent,null);
});

test("Venice: decimal strings, DIEM without allocation, and exhausted accounts",async () => {
  for (const [canConsume,balance] of [[true,"90.50"],[false,"90.50"],[true,"0"]] as const) {
    const [account] = await venice.fetch(fakeContext({env:{VENICE_KEY:"fake-api-key"},responses:[json({canConsume,consumptionCurrency:"DIEM",balances:{diem:balance}})]}));
    assert.equal(account.windows[0].used_percent,null);
    assert.equal(account.blocked,!canConsume || balance==="0");
  }
  const [quota] = await venice.fetch(fakeContext({env,responses:[json({...usage,balances:{diem:"90.50",usd:"25.75"},diemEpochAllocation:"100"})]}));
  assert.equal(quota.windows[0].used_percent,10);
});

for (const body of [
  {...usage,canConsume:1}, {...usage,balances:[]}, {...usage,balances:{diem:"NaN"}},
  {...usage,diemEpochAllocation:true}, {...usage,consumptionCurrency:1},
]) test("Venice: rejects invalid billing fields",async () => {
  await assert.rejects(venice.fetch(fakeContext({env,responses:[json(body)]})),HttpError);
});

test("venice: malformed success strings do not look authenticated", async () => {
  await assert.rejects(venice.fetch(fakeContext({ env, responses: [json("sign in"), ...extras.map((value) => json(value))] })), HttpError);
});

test("venice: CodexBar config key selection", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [{
      id: "venice", tokenAccounts: { activeIndex: 1, accounts: [{ token: "unused-key" }, { token: "fake-api-key" }] },
    }] }) }, responses: responses(),
  });
  await venice.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});

for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
  test(`venice: preserves transport failure ${name}`, async () => {
    const context = fakeContext({ env });
    const failure = new Error("request failed");
    failure.name = name;
    context.fetch = async () => { throw failure; };
    await assert.rejects(venice.fetch(context), (error: unknown) => error === failure);
  });
}

test("venice: primary environment name precedes its alias", async () => {
  const context = fakeContext({ env: {...env, VENICE_KEY: "unused-key"}, responses: responses() });
  await venice.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});
