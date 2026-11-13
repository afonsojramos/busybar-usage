import assert from "node:assert/strict";
import { test } from "node:test";
import { codebuff } from "../src/providers/codebuff.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const usage = {
  "usage": 1250,
  "quota": 5000,
  "remainingBalance": 3750,
  "autoTopupEnabled": true,
  "next_quota_reset": "2030-05-01T00:00:00Z"
};
const extras: unknown[] = [];
const env = { CODEBUFF_API_KEY: "fake-api-key" };
const responses = () => [json(usage), ...extras.map((body) => json(body))];

test("Codebuff: CodexBar-derived fixture and request", async () => {
  const context = fakeContext({ env, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.method ?? "GET", "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { fingerprintId: "codexbar-usage" });
    return fetch(input, init);
  };
  const [account] = await codebuff.fetch(context);
  assert.equal(account.provider, "codebuff");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.equal(account.blocked, false);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent, w.value ?? null]),
    [["quota", 25, null]]);
  assert.equal(context.calls[0].url, "https://www.codebuff.com/api/v1/usage");
  for (const call of context.calls) {
    assert.equal(call.headers["authorization"], "Bearer fake-api-key");
    assert.equal(call.headers.accept, "application/json");
  }
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});

test("Codebuff: missing credentials", async () => {
  await assert.rejects(codebuff.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`Codebuff: ${status} asks to sign in`, async () => {
    const [account] = await codebuff.fetch(fakeContext({ env, responses: [json({ secret: "private-body" }, status)] }));
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });
}

for (const retry of [undefined, "120"]) {
  test(`Codebuff: rate limit ${retry ?? "default"}`, async () => {
    await assert.rejects(codebuff.fetch(fakeContext({
      env, responses: [json({}, 429, retry ? { "retry-after": retry } : {})],
    })), (error: unknown) => error instanceof RateLimited && error.until === NOW + (retry ? 120 : 300));
  });
}

for (const body of ["private-body", "null", "[]", "{}"] ) {
  test(`Codebuff: rejects invalid body ${body} safely`, async () => {
    await assert.rejects(codebuff.fetch(fakeContext({
      env, responses: [new Response(body), ...extras.map((value) => json(value))],
    })), (error: unknown) => error instanceof HttpError && !error.message.includes("private-body"));
  });
}

test("Codebuff: HTTP errors omit response content", async () => {
  await assert.rejects(codebuff.fetch(fakeContext({env, responses: [json({ secret: "private-body" }, 503)]})),
    (error: unknown) => error instanceof HttpError && error.status === 503 && !error.message.includes("private-body"));
});

test("Codebuff: companion config supplies the API key", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { codebuff: { apiKey: "fake-api-key" } } }) },
    responses: responses(),
  });
  assert.equal((await codebuff.fetch(context))[0].windows.length, 1);
});

const credentialsPath = "/home/test/.config/manicode/credentials.json";
const sessionFiles = { [credentialsPath]: JSON.stringify({default:{authToken:"fake-session",email:"person@example.com"}}) };

test("Codebuff: CLI login adds weekly quota and account email",async () => {
  const context = fakeContext({files:sessionFiles,responses:[json(usage),json({
    subscription:{tier:"pro",billingPeriodEnd:"2030-05-15T00:00:00Z"},
    rateLimit:{weeklyUsed:2100,weeklyLimit:7000,weeklyResetsAt:"2030-05-08T00:00:00Z"},
    email:"person@work.example",
  })]});
  const [account] = await codebuff.fetch(context);
  assert.equal(account.account,"work");
  assert.deepEqual(account.windows.map((w)=>[w.name,w.used_percent]),[["7d",30],["quota",25]]);
  assert.equal(context.calls[1].url,"https://www.codebuff.com/api/user/subscription");
  assert.equal(context.calls[1].headers.authorization,"Bearer fake-session");
});

test("Codebuff: top-level CLI token and numeric date variants",async () => {
  for (const reset of [1893456000,1893456000000,"1893456000000","2030-01-01T00:00:00Z"]) {
    const [account] = await codebuff.fetch(fakeContext({
      files:{[credentialsPath]:JSON.stringify({authToken:"fake-session"})},
      responses:[json({used:"12",limit:"100",remaining:"88",next_quota_reset:reset}),json({user:{email:"user@example.com"},rateLimit:{used:"7",limit:"10"}})],
    }));
    assert.equal(account.account,"example");
    assert.equal(account.windows[0].used_percent,70);
    assert.equal(account.windows[1].used_percent,12);
    assert.equal(account.windows[1].resets_at,1893456000);
  }
});

test("Codebuff: API key wins over CLI login and omits subscription",async () => {
  const context = fakeContext({env,files:sessionFiles,responses:responses()});
  await codebuff.fetch(context);
  assert.equal(context.calls.length,1);
});

test("Codebuff: derives credit totals without inventing limits for balances",async () => {
  for (const [data,percent] of [[{usage:25,remainingBalance:75},25],[{quota:100,remainingBalance:75},25],[{remainingBalance:75},null]] as const) {
    const [account] = await codebuff.fetch(fakeContext({env,responses:[json(data)]}));
    assert.equal(account.windows[0].used_percent,percent);
  }
});

test("Codebuff: invalid credential files are not configured",async () => {
  for (const text of ["bad", "{}", JSON.stringify({default:{authToken:" "}})]) {
    await assert.rejects(codebuff.fetch(fakeContext({files:{[credentialsPath]:text}})),NotConfigured);
  }
});

for (const status of [401,403,429,503]) test(`Codebuff: subscription status ${status}`,async () => {
  const context = fakeContext({files:sessionFiles,responses:[json(usage),json({},status)]});
  if (status===401 || status===403) assert.equal((await codebuff.fetch(context))[0].error,"sign in");
  else await assert.rejects(codebuff.fetch(context),status===429?RateLimited:HttpError);
});

test("codebuff: malformed success strings do not look authenticated", async () => {
  await assert.rejects(codebuff.fetch(fakeContext({ env, responses: [json("sign in"), ...extras.map((value) => json(value))] })), HttpError);
});

test("codebuff: CodexBar config key selection", async () => {
  const context = fakeContext({
    files: { "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [{
      id: "codebuff", tokenAccounts: { activeIndex: 1, accounts: [{ token: "unused-key" }, { token: "fake-api-key" }] },
    }] }) }, responses: responses(),
  });
  await codebuff.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});

for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
  test(`codebuff: preserves transport failure ${name}`, async () => {
    const context = fakeContext({ env });
    const failure = new Error("request failed");
    failure.name = name;
    context.fetch = async () => { throw failure; };
    await assert.rejects(codebuff.fetch(context), (error: unknown) => error === failure);
  });
}

for (const endpoint of ["http://example.com", "https://name:password@example.com", "https://example.com?secret=value"]) {
  test("codebuff: rejects invalid endpoint overrides before sending credentials", async () => {
    const context = fakeContext({ env: { ...env, CODEBUFF_API_URL: endpoint } });
    await assert.rejects(codebuff.fetch(context), HttpError);
    assert.equal(context.calls.length, 0);
  });
}

test("Codebuff: quota-only and weekly-limit-only responses report zero used", async () => {
  const [account] = await codebuff.fetch(fakeContext({
    files: sessionFiles,
    responses: [json({ quota: 100 }), json({ rateLimit: { weeklyLimit: 10 } })],
  }));
  assert.equal(account.account, "example");
  assert.deepEqual(account.windows.map((w) => w.used_percent), [0, 0]);
});

test("Codebuff: top-level credential email identifies the token owner", async () => {
  const [account] = await codebuff.fetch(fakeContext({
    files: { [credentialsPath]: JSON.stringify({ authToken: "fake-session", email: "person@work.example" }) },
    responses: [json({}, 401)],
  }));
  assert.equal(account.account, "work");
  assert.equal(account.error, "sign in");
});

test("Codebuff: inferred credit totals cannot overflow", async () => {
  await assert.rejects(codebuff.fetch(fakeContext({
    env, responses: [json({ usage: 1e308, remainingBalance: 1e308 })],
  })), HttpError);
});
