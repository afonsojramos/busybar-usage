import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { deepseek } from "../src/providers/deepseek.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const usage = {
  "is_available": true,
  "balance_infos": [
    {
      "currency": "USD",
      "total_balance": "50.00",
      "granted_balance": "10.00",
      "topped_up_balance": "40.00"
    }
  ]
};
const extras: unknown[] = [];
const env = { DEEPSEEK_API_KEY: "fake-api-key" };
const responses = () => [json(usage), ...extras.map((body) => json(body))];

test("DeepSeek: CodexBar-derived fixture and request", async () => {
  const context = fakeContext({ env, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.method ?? "GET", "GET");
    return fetch(input, init);
  };
  const [account] = await deepseek.fetch(context);
  assert.equal(account.provider, "deepseek");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.equal(account.blocked, false);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent, w.value ?? null]),
    [["bal", null, "$50.00"]]);
  assert.equal(context.calls[0].url, "https://api.deepseek.com/user/balance");
  for (const call of context.calls) {
    assert.equal(call.headers["authorization"], "Bearer fake-api-key");
    assert.equal(call.headers.accept, "application/json");
  }
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});

test("DeepSeek: missing credentials", async () => {
  await assert.rejects(deepseek.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`DeepSeek: ${status} asks to sign in`, async () => {
    const [account] = await deepseek.fetch(fakeContext({ env, responses: [json({ secret: "private-body" }, status)] }));
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });
}

for (const retry of [undefined, "120"]) {
  test(`DeepSeek: rate limit ${retry ?? "default"}`, async () => {
    await assert.rejects(deepseek.fetch(fakeContext({
      env, responses: [json({}, 429, retry ? { "retry-after": retry } : {})],
    })), (error: unknown) => error instanceof RateLimited && error.until === NOW + (retry ? 120 : 300));
  });
}

for (const body of ["private-body", "null", "[]", "{}"] ) {
  test(`DeepSeek: rejects invalid body ${body} safely`, async () => {
    await assert.rejects(deepseek.fetch(fakeContext({
      env, responses: [new Response(body), ...extras.map((value) => json(value))],
    })), (error: unknown) => error instanceof HttpError && !error.message.includes("private-body"));
  });
}

test("DeepSeek: HTTP errors omit response content", async () => {
  await assert.rejects(deepseek.fetch(fakeContext({env, responses: [json({ secret: "private-body" }, 503)]})),
    (error: unknown) => error instanceof HttpError && error.status === 503 && !error.message.includes("private-body"));
});

test("DeepSeek: companion config supplies the API key", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { deepseek: { apiKey: "fake-api-key" } } }) },
    responses: responses(),
  });
  assert.equal((await deepseek.fetch(context))[0].windows.length, 1);
});

test("DeepSeek: prefers funded USD, then another funded currency", async () => {
  const entry = (currency: string, total_balance: string) => ({ currency, total_balance, granted_balance: "0", topped_up_balance: total_balance });
  for (const [balances, expected] of [
    [[entry("CNY", "100"), entry("USD", "20")], "$20.00"],
    [[entry("USD", "0"), entry("CNY", "100")], "¥100.00"],
    [[entry("USD", "0"), entry("CNY", "0")], "$0.00"],
    [[], "$0.00"],
  ] as const) {
    const [account] = await deepseek.fetch(fakeContext({env, responses: [json({is_available:true, balance_infos:balances})]}));
    assert.equal(account.windows[0].value, expected);
    assert.equal(account.blocked, expected === "$0.00");
  }
});

test("DeepSeek: unavailable funds block API calls", async () => {
  const [account] = await deepseek.fetch(fakeContext({env, responses: [json({...usage, is_available:false})]}));
  assert.equal(account.blocked, true);
  assert.equal(account.windows[0].value, "$50.00");
});

for (const body of [
  {...usage, is_available:"true"}, {...usage, balance_infos:[{...usage.balance_infos[0],total_balance:"NaN"}]},
  {...usage, balance_infos:[{...usage.balance_infos[0],granted_balance:5}]},
  {...usage, balance_infos:[{...usage.balance_infos[0],currency:null}]},
]) test("DeepSeek: rejects malformed balance fields", async () => {
  await assert.rejects(deepseek.fetch(fakeContext({env,responses:[json(body)]})), HttpError);
});

test("deepseek: malformed success strings do not look authenticated", async () => {
  await assert.rejects(deepseek.fetch(fakeContext({ env, responses: [json("sign in"), ...extras.map((value) => json(value))] })), HttpError);
});

test("deepseek: CodexBar config key selection", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [{
      id: "deepseek", tokenAccounts: { activeIndex: 1, accounts: [{ token: "unused-key" }, { token: "fake-api-key" }] },
    }] }) }, responses: responses(),
  });
  await deepseek.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});

for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
  test(`deepseek: preserves transport failure ${name}`, async () => {
    const context = fakeContext({ env });
    const failure = new Error("request failed");
    failure.name = name;
    context.fetch = async () => { throw failure; };
    await assert.rejects(deepseek.fetch(context), (error: unknown) => error === failure);
  });
}

test("deepseek: primary environment name precedes its alias", async () => {
  const context = fakeContext({ env: {...env, DEEPSEEK_KEY: "unused-key"}, responses: responses() });
  await deepseek.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});
