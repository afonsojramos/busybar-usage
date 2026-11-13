import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { vercel } from "../src/providers/vercel.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { AI_GATEWAY_API_KEY: "fake-key" };
const fixture = [{ balance: "12.40", total_used: "2.00" }];

test("vercel: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map((body) => json(body)) });
  const [account] = await vercel.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "vercel");
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [null, null],
  );
  assert.deepEqual(
    account.windows.map((w) => w.value ?? null),
    ["$12.40", "$2.00"],
  );
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://ai-gateway.vercel.sh/v1/credits"));
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-key");
});

test("vercel: missing credential", async () => {
  await assert.rejects(vercel.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`vercel: ${status} requires sign in`, async () => {
    const [account] = await vercel.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account?.error, "sign in");
    assert.deepEqual(account?.windows, []);
  });

test("vercel: rate limit preserves Retry-After", async () => {
  await assert.rejects(
    vercel.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    (error) => error instanceof RateLimited && error.until === NOW + 42,
  );
  await assert.rejects(
    vercel.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    (error) => error instanceof RateLimited && error.until === NOW + 300,
  );
});

test("vercel: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(
      vercel.fetch(fakeContext({ env, responses: [response] })),
      (error) => error instanceof HttpError && !error.message.includes("fake-private-body"),
    );
  }
});

const personalEnv = {
  VERCEL_ACCESS_TOKEN: "fake-personal",
  VERCEL_TEAM_ID: "team_fixture",
  AI_GATEWAY_API_KEY: "fake-gateway",
};
const user = { user: { id: "fixtureUser", email: "fixture@example.com" } };
const budget = {
  scopeType: "user",
  scopeId: "usr_fixtureUser",
  currentSpend: 30,
  limitAmount: 120,
  refreshPeriod: "monthly",
  active: true,
  archived: false,
};

test("vercel: personal custom budget wins across pages and secrets stay on their host", async () => {
  const context = fakeContext({
    env: personalEnv,
    responses: [
      json(user),
      json({ budgets: [{ ...budget, source: "default", currentSpend: 90 }], nextCursor: "next/a" }),
      json({ budgets: [budget] }),
    ],
  });
  const [a] = await vercel.fetch(context);
  assert.equal(a?.windows[0]?.used_percent, 25);
  assert.equal(a?.windows[0]?.minutes, 43200);
  assert.equal(a?.account, "example");
  assert.ok(
    context.calls.every(
      (c) => c.url.startsWith("https://api.vercel.com/") && c.headers.authorization === "Bearer fake-personal",
    ),
  );
  assert.ok(context.calls[2]?.url.endsWith("&cursor=next%2Fa"));
});

test("vercel: reset periods, missing and ambiguous budget, cursor loop", async () => {
  for (const [period, minutes] of [
    ["daily", 1440],
    ["weekly", 10080],
    ["none", null],
  ] as const) {
    const [a] = await vercel.fetch(
      fakeContext({
        env: personalEnv,
        responses: [json(user), json({ budgets: [{ ...budget, refreshPeriod: period }] })],
      }),
    );
    assert.equal(a?.windows[0]?.minutes, minutes);
    assert.equal(a?.windows[0]?.resets_at === null, period === "none");
  }
  const [missing] = await vercel.fetch(
    fakeContext({ env: personalEnv, responses: [json(user), json({ budgets: [] })] }),
  );
  assert.equal(missing?.error, "no budget");
  for (const pages of [
    [{ budgets: [budget, budget] }],
    [
      { budgets: [], nextCursor: "same" },
      { budgets: [], nextCursor: "same" },
    ],
    [{ budgets: [{ ...budget, active: "yes" }] }],
    [{ budgets: [{ ...budget, currentSpend: -1 }] }],
  ])
    await assert.rejects(
      vercel.fetch(fakeContext({ env: personalEnv, responses: [json(user), ...pages.map((b) => json(b))] })),
      HttpError,
    );
});

test("vercel: personal HTTP failures and missing team", async () => {
  await assert.rejects(vercel.fetch(fakeContext({ env: { VERCEL_ACCESS_TOKEN: "fake-personal" } })), NotConfigured);
  for (const status of [401, 403]) {
    const [a] = await vercel.fetch(fakeContext({ env: personalEnv, responses: [json(user), json({}, status)] }));
    assert.equal(a?.error, "sign in");
  }
  await assert.rejects(
    vercel.fetch(fakeContext({ env: personalEnv, responses: [json(user), json({}, 429)] })),
    RateLimited,
  );
});

test("vercel: config key and request safety", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { vercel: { apiKey: "fake-config", workspaceID: "team-1234" } },
      }),
    },
    responses: fixture.map((b) => json(b)),
  });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.redirect, "error");
    return fetch(input, init);
  };
  await vercel.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-config");
});

test("vercel: CodexBar plugin secret selects the personal view", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/codexbar/config.json": JSON.stringify({
        providers: [
          {
            id: "vercel",
            apiKey: "fake-gateway",
            pluginSecrets: { VERCEL_ACCESS_TOKEN: "fake-personal" },
            workspaceID: "team_fixture",
          },
        ],
      }),
    },
    responses: [json(user), json({ budgets: [budget] })],
  });
  const [a] = await vercel.fetch(context);
  assert.equal(a?.windows[0]?.used_percent, 25);
  assert.ok(context.calls.every((c) => c.headers.authorization === "Bearer fake-personal"));
});
