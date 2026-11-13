import assert from "node:assert/strict";
import { test } from "node:test";
import { moonshot } from "../src/providers/moonshot.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const usage = {
  "code": 0,
  "data": {
    "available_balance": 49.58,
    "voucher_balance": 50,
    "cash_balance": 12.34
  },
  "scode": "0x0",
  "status": true
};
const extras: unknown[] = [];
const env = { MOONSHOT_API_KEY: "fake-api-key" };
const responses = () => [json(usage), ...extras.map((body) => json(body))];

test("Moonshot: CodexBar-derived fixture and request", async () => {
  const context = fakeContext({ env, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.method ?? "GET", "GET");
    return fetch(input, init);
  };
  const [account] = await moonshot.fetch(context);
  assert.equal(account.provider, "moonshot");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.equal(account.blocked, false);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent, w.value ?? null]),
    [["bal", null, "$49.58"]]);
  assert.equal(context.calls[0].url, "https://api.moonshot.ai/v1/users/me/balance");
  for (const call of context.calls) {
    assert.equal(call.headers["authorization"], "Bearer fake-api-key");
    assert.equal(call.headers.accept, "application/json");
  }
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});

test("Moonshot: missing credentials", async () => {
  await assert.rejects(moonshot.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`Moonshot: ${status} asks to sign in`, async () => {
    const [account] = await moonshot.fetch(fakeContext({ env, responses: [json({ secret: "private-body" }, status)] }));
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });
}

for (const retry of [undefined, "120"]) {
  test(`Moonshot: rate limit ${retry ?? "default"}`, async () => {
    await assert.rejects(moonshot.fetch(fakeContext({
      env, responses: [json({}, 429, retry ? { "retry-after": retry } : {})],
    })), (error: unknown) => error instanceof RateLimited && error.until === NOW + (retry ? 120 : 300));
  });
}

for (const body of ["private-body", "null", "[]", "{}"] ) {
  test(`Moonshot: rejects invalid body ${body} safely`, async () => {
    await assert.rejects(moonshot.fetch(fakeContext({
      env, responses: [new Response(body), ...extras.map((value) => json(value))],
    })), (error: unknown) => error instanceof HttpError && !error.message.includes("private-body"));
  });
}

test("Moonshot: HTTP errors omit response content", async () => {
  await assert.rejects(moonshot.fetch(fakeContext({env, responses: [json({ secret: "private-body" }, 503)]})),
    (error: unknown) => error instanceof HttpError && error.status === 503 && !error.message.includes("private-body"));
});

test("Moonshot: companion config supplies the API key", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { moonshot: { apiKey: "fake-api-key" } } }) },
    responses: responses(),
  });
  assert.equal((await moonshot.fetch(context))[0].windows.length, 1);
});

test("Moonshot: China balance and deficit keep their currency", async () => {
  const context = fakeContext({ env:{MOONSHOT_KEY:"fake-api-key",MOONSHOT_REGION:"china"},
    responses:[json({...usage,data:{...usage.data,cash_balance:-12.34}})] });
  const [account] = await moonshot.fetch(context);
  assert.equal(context.calls[0].url,"https://api.moonshot.cn/v1/users/me/balance");
  assert.deepEqual(account.windows.map((w) => w.value),["¥49.58","¥12.34"]);
});

test("Moonshot: saved key stays on its regional host", async () => {
  const files = {"/home/test/.config/codexbar/config.json": JSON.stringify({providers:[{id:"moonshot",apiKey:"fake-api-key",region:"china",apiKeyRegion:"china"}]})};
  const context = fakeContext({ files,responses:responses() });
  await moonshot.fetch(context);
  assert.match(context.calls[0].url, /api\.moonshot\.cn/);
  const switched = fakeContext({files,env:{MOONSHOT_REGION:"international"}});
  await assert.rejects(moonshot.fetch(switched),NotConfigured);
  assert.equal(switched.calls.length,0);
});

for (const body of [
  {...usage,code:1}, {...usage,status:false}, {...usage,scode:0},
  {...usage,data:{...usage.data,available_balance:"49.58"}},
  {...usage,data:{...usage.data,voucher_balance:null}},
]) test("Moonshot: rejects invalid envelopes or balances",async () => {
  await assert.rejects(moonshot.fetch(fakeContext({env,responses:[json(body)]})),HttpError);
});

test("Moonshot: empty balance blocks",async () => {
  const [account] = await moonshot.fetch(fakeContext({env,responses:[json({...usage,data:{...usage.data,available_balance:0}})]}));
  assert.equal(account.blocked,true);
});

test("moonshot: malformed success strings do not look authenticated", async () => {
  await assert.rejects(moonshot.fetch(fakeContext({ env, responses: [json("sign in"), ...extras.map((value) => json(value))] })), HttpError);
});

test("moonshot: CodexBar config key selection", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [{
      id: "moonshot", tokenAccounts: { activeIndex: 1, accounts: [{ token: "unused-key" }, { token: "fake-api-key" }] },
    }] }) }, responses: responses(),
  });
  await moonshot.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});

for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
  test(`moonshot: preserves transport failure ${name}`, async () => {
    const context = fakeContext({ env });
    const failure = new Error("request failed");
    failure.name = name;
    context.fetch = async () => { throw failure; };
    await assert.rejects(moonshot.fetch(context), (error: unknown) => error === failure);
  });
}

test("moonshot: primary environment name precedes its alias", async () => {
  const context = fakeContext({ env: {...env, MOONSHOT_KEY: "unused-key"}, responses: responses() });
  await moonshot.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});
