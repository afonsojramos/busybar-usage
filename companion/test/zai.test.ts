import assert from "node:assert/strict";
import { test } from "node:test";
import { zai } from "../src/providers/zai.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { Z_AI_API_KEY: "fake-zai" };
const configPath = "/home/test/.config/codexbar/config.json";
const config = (entry: Record<string, unknown>) => JSON.stringify({ providers: [{ id: "zai", ...entry }] });
const envelope = (limits: unknown[]) => ({ code: 200, success: true, data: { limits } });
// Adapted from ZaiProviderTests.quotaFixture, reset dates moved with the test clock.
const usage = envelope([
  { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25, nextResetTime: (NOW + 3600) * 1000 },
  { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 9, nextResetTime: (NOW + 604800) * 1000 },
  { type: "TIME_LIMIT", unit: 5, number: 1, usage: 1000, currentValue: 224, remaining: 776, percentage: 22 },
]);

test("z.ai Global keeps Coding Plan before MCP", async () => {
  const context = fakeContext({ env, responses: [json(usage)] });
  const [account] = await zai.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.minutes, w.used_percent, w.resets_at]), [["5h", 300, 25, NOW + 3600], ["7d", 10080, 9, NOW + 604800]]);
  assert.equal(account.account, "default");
  assert.equal(context.calls[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-zai");
  assert.equal(context.calls[0].headers.accept, "application/json");
});

test("z.ai credit counts override percentage, preserve longest plan lane and dropped blocking", async () => {
  const [account] = await zai.fetch(fakeContext({ env, responses: [json(envelope([
    { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 2, usage: 1000, currentValue: 250, remaining: 800 },
    { type: "CREDIT_LIMIT", unit: 1, number: 1, percentage: 100 },
    { type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 9 },
  ]))] }));
  assert.deepEqual(account.windows.map((w) => [w.minutes, w.used_percent]), [[300, 25], [10080, 9]]);
  assert.equal(account.blocked, true);
});

for (const [unit, number, minutes, name] of [[5, 1, 43200, "30d"], [3, 5, 300, "5h"], [0, 1, null, "MCP"]]) {
  test(`z.ai MCP cadence ${unit}`, async () => {
    const [account] = await zai.fetch(fakeContext({ env, responses: [json(envelope([{ type: "TIME_LIMIT", unit, number, percentage: 22 }]))] }));
    assert.deepEqual(account.windows.map((w) => [w.minutes, w.name]), [[minutes, name]]);
  });
}

test("z.ai rejects implausible five-hour resets without changing usage", async () => {
  const [account] = await zai.fetch(fakeContext({ env, responses: [json(envelope([{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 44, nextResetTime: (NOW + 36000) * 1000 }]))] }));
  assert.equal(account.windows[0].resets_at, null);
  assert.equal(account.windows[0].used_percent, 44);
});

test("z.ai monthly duration and expired reset", async () => {
  const [account] = await zai.fetch(fakeContext({ env, responses: [json(envelope([{ type: "CREDIT_LIMIT", unit: 1, number: 30, percentage: 100, nextResetTime: (NOW - 1) * 1000 }]))] }));
  assert.deepEqual(account.windows.map((w) => [w.name, w.minutes, w.used_percent]), [["30d", 43200, 0]]);
  assert.equal(account.blocked, false);
});

for (const key of ["BIGMODEL_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY", "GLM_API_KEY"]) {
  test(`z.ai CN alias ${key} needs a CN route`, async () => {
    await assert.rejects(zai.fetch(fakeContext({ env: { [key]: "fake-cn" } })), NotConfigured);
    const context = fakeContext({ env: { [key]: "fake-cn", Z_AI_API_HOST: "open.bigmodel.cn" }, responses: [json(usage)] });
    await zai.fetch(context);
    assert.equal(context.calls[0].url, "https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    assert.equal(context.calls[0].headers.authorization, "Bearer fake-cn");
  });
}

for (const relative of [".coding-relay/glm-api-key", ".config/bigmodel/api_key", ".config/zhipu/api_key"]) {
  test(`z.ai reads CN key file ${relative} only in CN`, async () => {
    const files = { [`/home/test/${relative}`]: "fake-file-key\nignored-second-line" };
    await assert.rejects(zai.fetch(fakeContext({ files })), NotConfigured);
    const context = fakeContext({ files: { ...files, [configPath]: config({ region: "bigmodel-cn" }) }, responses: [json(usage)] });
    await zai.fetch(context);
    assert.equal(context.calls[0].headers.authorization, "Bearer fake-file-key");
  });
}

test("z.ai API key order and config token account team headers", async () => {
  const context = fakeContext({
    files: { [configPath]: config({ region: "bigmodel-cn", tokenAccounts: { activeIndex: 1, accounts: [
      { token: "fake-unused" }, { token: "fake-team", usageScope: "team", organizationId: "org-fixture", workspaceID: "project-fixture" },
    ] } }) },
    env: { Z_AI_QUOTA_URL: "open.bigmodel.cn/quota?keep=1&type=9" }, responses: [json(usage)],
  });
  await zai.fetch(context);
  assert.equal(context.calls[0].url, "https://open.bigmodel.cn/quota?keep=1&type=2");
  assert.equal(context.calls[0].headers["bigmodel-organization"], "org-fixture");
  assert.equal(context.calls[0].headers["bigmodel-project"], "project-fixture");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-team");
  const ordered = fakeContext({ env: { Z_AI_API_HOST: "open.bigmodel.cn", ...env, BIGMODEL_API_KEY: "fake-lower" }, responses: [json(usage)] });
  await zai.fetch(ordered);
  assert.equal(ordered.calls[0].headers.authorization, "Bearer fake-zai");
});

for (const overrides of [
  { Z_AI_API_HOST: "http://unsafe.test" }, { Z_AI_QUOTA_URL: "http://unsafe.test" },
  { Z_AI_BALANCE_URL: "http://unsafe.test" },
]) {
  test(`z.ai validates override ${Object.keys(overrides)[0]} before network`, async () => {
    const context = fakeContext({ env: { ...env, ...overrides } });
    await assert.rejects(zai.fetch(context));
    assert.equal(context.calls.length, 0);
  });
}

test("z.ai rejects config region mismatch and incomplete team selectors", async () => {
  for (const entry of [{ region: "global" }, { region: "bigmodel-cn", tokenAccounts: { accounts: [{ token: "fake-team", usageScope: "team" }] } }]) {
    const context = fakeContext({ env: { ...env, Z_AI_API_HOST: "open.bigmodel.cn" }, files: { [configPath]: config(entry) } });
    await assert.rejects(zai.fetch(context));
    assert.equal(context.calls.length, 0);
  }
});

test("z.ai rejects an override on another host", async () => {
  await assert.rejects(zai.fetch(fakeContext({ env: { ...env, Z_AI_QUOTA_URL: "https://proxy.test/quota" } })));
});

test("z.ai higher-priority quota URL ignores stale host", async () => {
  const context = fakeContext({ env: { ...env, Z_AI_QUOTA_URL: "api.z.ai/quota", Z_AI_API_HOST: "http://stale.test" }, responses: [json(usage)] });
  await zai.fetch(context);
  assert.equal(context.calls[0].url, "https://api.z.ai/quota");
});

const noPlan = { code: 500, success: false, msg: "当前用户不存在coding plan" };
test("z.ai CN prepaid-only balance uses same bearer", async () => {
  const context = fakeContext({ env: { ...env, Z_AI_API_HOST: "open.bigmodel.cn" }, responses: [json(noPlan), json({ success: true, data: { availableBalance: null, balance: "12.4" } })] });
  const [account] = await zai.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.value, w.used_percent]), [["CNY", "¥12.40", null]]);
  assert.equal(context.calls[1].url, "https://www.bigmodel.cn/api/biz/account/query-customer-account-report");
  assert.equal(context.calls[1].headers.authorization, "Bearer fake-zai");
});

test("z.ai missing key", async () => { await assert.rejects(zai.fetch(fakeContext({})), NotConfigured); });
for (const status of [401, 403]) {
  test(`z.ai HTTP ${status} asks to sign in`, async () => {
    const [account] = await zai.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account.error, "sign in");
  });
}
for (const delay of [null, "45"]) {
  test(`z.ai 429 delay ${delay}`, async () => {
    await assert.rejects(zai.fetch(fakeContext({ env, responses: [json({}, 429, delay ? { "retry-after": delay } : {})] })),
      (error: unknown) => error instanceof RateLimited && error.until === NOW + (delay ? 45 : 300));
  });
}
for (const response of [json({}, 500), json({}), json(null), json(envelope([{}])), json(envelope([{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: "25" }])), new Response("fake-secret")]) {
  test(`z.ai rejects invalid response ${response.status} ${response.bodyUsed}`, async () => {
    await assert.rejects(zai.fetch(fakeContext({ env, responses: [response] })), (error: unknown) => error instanceof HttpError && !error.message.includes("fake-secret"));
  });
}

test("z.ai unknown types skip legacy fields but unavailable quotas remain explicit", async () => {
  const [account] = await zai.fetch(fakeContext({ env, responses: [json(envelope([{ type: "FUTURE_LIMIT" }, usage.data.limits[0]]))] }));
  assert.equal(account.windows.length, 1);
  const [unavailable] = await zai.fetch(fakeContext({ env, responses: [json(envelope([{ type: "FUTURE_LIMIT" }]))] }));
  assert.equal(unavailable.error, "no quota");
});

test("z.ai local key fallback preserves CodexBar file precedence", async () => {
  const context = fakeContext({ env: { Z_AI_API_HOST: "open.bigmodel.cn" }, files: {
    "/home/test/.coding-relay/glm-api-key": "fake-first\n",
    "/home/test/.config/bigmodel/api_key": "fake-second",
  }, responses: [json(usage)] });
  await zai.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-first");
});

test("z.ai companion config key and request timeout", async () => {
  const context = fakeContext({ files: {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { zai: { apiKey: "fake-companion" } } }),
  } });
  context.fetch = async (_input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fake-companion");
    assert.ok(init?.signal instanceof AbortSignal);
    return json(usage);
  };
  await zai.fetch(context);
});

for (const raw of [
  { percentage: 10, usage: 100, remaining: 20 },
  { percentage: 10, usage: 100, currentValue: 80 },
]) {
  test(`z.ai counts branch ${Object.keys(raw).at(-1)}`, async () => {
    const [account] = await zai.fetch(fakeContext({ env, responses: [json(envelope([{ type: "CREDIT_LIMIT", unit: 5, number: 60, ...raw }]))] }));
    assert.equal(account.windows[0].used_percent, 80);
  });
}

for (const status of [401, 403, 429, 500]) {
  test(`z.ai prepaid balance HTTP ${status}`, async () => {
    const context = fakeContext({ env: { ...env, Z_AI_API_HOST: "open.bigmodel.cn" }, responses: [json(noPlan), json({}, status)] });
    if (status === 401 || status === 403) {
      const [account] = await zai.fetch(context);
      assert.equal(account.error, "sign in");
    } else {
      await assert.rejects(zai.fetch(context), status === 429 ? RateLimited : HttpError);
    }
  });
}

for (const balance of [json({ success: true, data: {} }), json({ success: false, data: { balance: 4 } }), new Response("fake-secret")]) {
  test("z.ai rejects unparseable prepaid balance", async () => {
    await assert.rejects(zai.fetch(fakeContext({ env: { ...env, Z_AI_API_HOST: "open.bigmodel.cn" }, responses: [json(noPlan), balance] })), HttpError);
  });
}

test("z.ai prepaid balance remains bounded and exhausted balance blocks", async () => {
  for (const value of [0, -1, 1e100]) {
    const [account] = await zai.fetch(fakeContext({ env: { ...env, Z_AI_API_HOST: "open.bigmodel.cn" }, responses: [json(noPlan), json({ success: true, data: { availableBalance: value } })] }));
    assert.equal(account.blocked, value <= 0);
    assert.ok((account.windows[0].value?.length ?? 100) <= 12);
  }
});

test("z.ai labels the account from a supplied response email", async () => {
  for (const body of [{ ...usage, email: "fake@example.org" }, { ...usage, data: { ...usage.data, email: "fake@example.org" } }]) {
    const [account] = await zai.fetch(fakeContext({ env, responses: [json(body)] }));
    assert.equal(account.account, "example");
  }
});
