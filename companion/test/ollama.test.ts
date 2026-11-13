import assert from "node:assert/strict";
import { test } from "node:test";
import { ollama } from "../src/providers/ollama.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const usage = {
  "included": {
    "balance_usd": "52.50",
    "allowance_usd": 60,
    "period": {
      "from": "2026-09-30T15:14:29Z",
      "until": "2030-10-30T15:14:29Z"
    }
  },
  "purchased": {
    "balance_usd": "18.25"
  }
};
const extras: unknown[] = [];
const env = { OLLAMA_API_KEY: "fake-api-key" };
const responses = () => [json(usage), ...extras.map((body) => json(body))];

test("Ollama: CodexBar-derived fixture and request", async () => {
  const context = fakeContext({ env, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.method ?? "GET", "GET");
    return fetch(input, init);
  };
  const [account] = await ollama.fetch(context);
  assert.equal(account.provider, "ollama");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.equal(account.blocked, false);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent, w.value ?? null]),
    [["30d", 13, null], ["bal", null, "$18.25"]]);
  assert.equal(context.calls[0].url, "https://ollama.com/api/balance");
  for (const call of context.calls) {
    assert.equal(call.headers["authorization"], "Bearer fake-api-key");
    assert.equal(call.headers.accept, "application/json");
  }
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});

test("Ollama: missing credentials", async () => {
  await assert.rejects(ollama.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`Ollama: ${status} asks to sign in`, async () => {
    const [account] = await ollama.fetch(fakeContext({ env, responses: [json({ secret: "private-body" }, status)] }));
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });
}

for (const retry of [undefined, "120"]) {
  test(`Ollama: rate limit ${retry ?? "default"}`, async () => {
    await assert.rejects(ollama.fetch(fakeContext({
      env, responses: [json({}, 429, retry ? { "retry-after": retry } : {})],
    })), (error: unknown) => error instanceof RateLimited && error.until === NOW + (retry ? 120 : 300));
  });
}

for (const body of ["private-body", "null", "[]", "{}"] ) {
  test(`Ollama: rejects invalid body ${body} safely`, async () => {
    await assert.rejects(ollama.fetch(fakeContext({
      env, responses: [new Response(body), ...extras.map((value) => json(value))],
    })), (error: unknown) => error instanceof HttpError && !error.message.includes("private-body"));
  });
}

test("Ollama: HTTP errors omit response content", async () => {
  await assert.rejects(ollama.fetch(fakeContext({env, responses: [json({ secret: "private-body" }, 503)]})),
    (error: unknown) => error instanceof HttpError && error.status === 503 && !error.message.includes("private-body"));
});

test("Ollama: companion config supplies the API key", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { ollama: { apiKey: "fake-api-key" } } }) },
    responses: responses(),
  });
  assert.equal((await ollama.fetch(context))[0].windows.length, 2);
});

test("Ollama: legacy windows win and drop purchased credits when both lanes are used",async () => {
  const [account] = await ollama.fetch(fakeContext({env,responses:[json({included:{
    ...usage.included,session:{remaining_percent:100,resets_at:"2030-11-06T18:00:00Z"},
    weekly:{remaining_percent:84.96,resets_at:"2030-11-09T00:00:00Z"},
  },purchased:{balance_usd:10}})]}));
  assert.deepEqual(account.windows.map((w)=>[w.name,w.used_percent,w.minutes]),[["5h",0,300],["7d",15,10080]]);
});

test("Ollama: weekly only, purchased only, zero allowance and exhaustion",async () => {
  for (const [body,name,percent,value] of [
    [{included:{weekly:{remaining_percent:"58"}}},"7d",42,undefined],
    [{purchased:{balance_usd:0}},"bal",null,"$0.00"],
    [{included:{allowance_usd:0,balance_usd:0}},"spent",null,"$0.00"],
    [{included:{allowance_usd:"60.00",balance_usd:"-2.50"}},"30d",100,undefined],
  ] as const) {
    const [account] = await ollama.fetch(fakeContext({env,responses:[json(body)]}));
    assert.equal(account.windows[0].name,name);
    assert.equal(account.windows[0].used_percent,percent);
    assert.equal(account.windows[0].value,value);
    assert.equal(account.blocked,percent===100);
  }
});

for (const body of [
  {purchased:{balance_usd:"0x10"}}, {purchased:{balance_usd:null}},
  {included:{allowance_usd:-1,balance_usd:0}}, {included:{allowance_usd:60,balance_usd:true}},
  {included:{session:{remaining_percent:101}}}, {included:{weekly:{remaining_percent:-1}}},
  {included:{session:{remaining_percent:50,resets_at:"2026-02-31T00:00:00Z"}}},
  {included:{session:{remaining_percent:50,resets_at:"2026-10-30"}}},
  {included:{allowance_usd:60,balance_usd:0,period:[]}},
]) test("Ollama: rejects invalid amounts and supplied resets",async () => {
  await assert.rejects(ollama.fetch(fakeContext({env,responses:[json(body)]})),HttpError);
});

test("ollama: malformed success strings do not look authenticated", async () => {
  await assert.rejects(ollama.fetch(fakeContext({ env, responses: [json("sign in"), ...extras.map((value) => json(value))] })), HttpError);
});

test("ollama: CodexBar config key selection", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [{
      id: "ollama", tokenAccounts: { activeIndex: 1, accounts: [{ token: "unused-key" }, { token: "fake-api-key" }] },
    }] }) }, responses: responses(),
  });
  await ollama.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});

for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
  test(`ollama: preserves transport failure ${name}`, async () => {
    const context = fakeContext({ env });
    const failure = new Error("request failed");
    failure.name = name;
    context.fetch = async () => { throw failure; };
    await assert.rejects(ollama.fetch(context), (error: unknown) => error === failure);
  });
}
