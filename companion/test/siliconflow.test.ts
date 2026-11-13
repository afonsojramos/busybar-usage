import assert from "node:assert/strict";
import { test } from "node:test";
import { siliconflow } from "../src/providers/siliconflow.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
} from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic counters follow CodexBar's provider fixture; dates are moved beyond NOW.
const fixture = {
  code: 20000,
  status: true,
  data: {
    totalBalance: "88.88",
    chargeBalance: "88.00",
    balance: "0.88",
    status: "normal",
  },
};
const configured = { env: { SILICONFLOW_API_KEY: "fake-key" }, files: {} };
const responses = (body: unknown = fixture) => [json(body)];

test("siliconflow: maps the CodexBar contract and sends the expected credential", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const [account] = await siliconflow.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => w.name),
    ["Balance", "Bought"],
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    ["\u00a588.88", "\u00a588.00"],
  );
  assert.equal(context.calls[0].url, "https://api.siliconflow.cn/v1/user/info");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-key");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
});

test("siliconflow: missing credentials are not configured", async () => {
  await assert.rejects(siliconflow.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`siliconflow: HTTP ${status} requests sign-in`, async () => {
    const context = fakeContext({
      ...configured,
      responses: [json({}, status)],
    });
    const [account] = await siliconflow.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("siliconflow: rate limiting honors Retry-After", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(
    siliconflow.fetch(context),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 120,
  );
});

test("siliconflow: malformed payloads and HTTP errors are sanitized", async () => {
  for (const response of [
    json({}),
    new Response("secret-body"),
    json({}, 500),
  ]) {
    const context = fakeContext({ ...configured, responses: [response] });
    await assert.rejects(
      siliconflow.fetch(context),
      (e: unknown) =>
        e instanceof HttpError && !e.message.includes("secret-body"),
    );
  }
});

test("siliconflow: international origin and overdue balances", async () => {
  const context = fakeContext({
    ...configured,
    env: {
      ...configured.env,
      SILICONFLOW_BASE_URL: "https://api.siliconflow.com/v1/",
    },
    responses: responses({
      code: 20000,
      status: true,
      data: { totalBalance: "-2.50" },
    }),
  });
  const [account] = await siliconflow.fetch(context);
  assert.equal(account.windows[0].value, "$-2.50");
  assert.equal(account.blocked, true);
  assert.equal(
    context.calls[0].url,
    "https://api.siliconflow.com/v1/user/info",
  );
});

test("siliconflow: rejects untrusted origins before sending credentials", async () => {
  for (const origin of [
    "https://attacker.test",
    "http://api.siliconflow.cn",
    "https://api.siliconflow.cn/other",
    "https://user:pass@api.siliconflow.cn",
    "https://api.siliconflow.cn?q=1",
    "https://api.siliconflow.cn:444",
  ]) {
    const context = fakeContext({
      ...configured,
      env: { ...configured.env, SILICONFLOW_BASE_URL: origin },
    });
    await assert.rejects(siliconflow.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
});

test("siliconflow: body errors and malformed balances", async () => {
  const [account] = await siliconflow.fetch(
    fakeContext({ ...configured, responses: responses({ code: 30014 }) }),
  );
  assert.equal(account.error, "sign in");
  for (const body of [
    { code: 20092 },
    { code: 20000, status: false, data: {} },
    { code: 20000, status: true, data: { totalBalance: "1e2" } },
    {
      code: 20000,
      status: true,
      data: { totalBalance: 1, status: "unsafe status" },
    },
  ]) {
    await assert.rejects(
      siliconflow.fetch(
        fakeContext({ ...configured, responses: responses(body) }),
      ),
      HttpError,
    );
  }
});

test("siliconflow: every request has a timeout and rejects redirects", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  await siliconflow.fetch(context);
});

test("siliconflow: saved API key is resolved from companion config", async () => {
  const env = Object.fromEntries(
    Object.entries(configured.env).filter(([name]) => !/KEY|TOKEN/.test(name)),
  );
  const context = fakeContext({
    env,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { siliconflow: { apiKey: "saved-key" } },
      }),
    },
    responses: responses(),
  });
  await siliconflow.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer saved-key");
});
