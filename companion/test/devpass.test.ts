import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { devpass } from "../src/providers/devpass.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { DEVPASS_API_KEY: "fake-key" };
const fixture = [
  {
    data: {
      label: "Fixture key",
      usage: "31.42",
      limit: null,
      devPlan: "pro",
      devPlanCreditsUsed: "25",
      devPlanCreditsLimit: "237",
      devPlanCreditsRemaining: "212.00",
      devPlanPremiumWeeklyLimit: "35.55",
      devPlanPremiumCreditsUsed: "5.00",
      devPlanPremiumWeekResetsAt: "2027-10-01T12:00:00.000Z",
    },
  },
];

test("devpass: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map((body) => json(body)) });
  const [account] = await devpass.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "devpass");
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [14, 11],
  );
  assert.deepEqual(
    account.windows.map((w) => w.value ?? null),
    [null, null],
  );
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://api.llmgateway.io/v1/key"));
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-key");
});

test("devpass: missing credential", async () => {
  await assert.rejects(devpass.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`devpass: ${status} requires sign in`, async () => {
    const [account] = await devpass.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account?.error, "sign in");
    assert.deepEqual(account?.windows, []);
  });

test("devpass: rate limit preserves Retry-After", async () => {
  await assert.rejects(
    devpass.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    (error) => error instanceof RateLimited && error.until === NOW + 42,
  );
  await assert.rejects(
    devpass.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    (error) => error instanceof RateLimited && error.until === NOW + 300,
  );
});

test("devpass: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(
      devpass.fetch(fakeContext({ env, responses: [response] })),
      (error) => error instanceof HttpError && !error.message.includes("fake-private-body"),
    );
  }
});

test("devpass: PAYG, inactive weekly allowance and over-limit cycle", async () => {
  const data = fixture[0]!.data;
  const [payg] = await devpass.fetch(fakeContext({ env, responses: [json({ data: { ...data, devPlan: "none" } })] }));
  assert.equal(payg?.windows[0]?.value, "$31.42");
  const [inactive] = await devpass.fetch(
    fakeContext({
      env,
      responses: [json({ data: { ...data, devPlanPremiumCreditsUsed: "0", devPlanPremiumWeekResetsAt: null } })],
    }),
  );
  assert.equal(inactive?.windows[0]?.used_percent, 0);
  assert.equal(inactive?.windows[0]?.resets_at, null);
  const [over] = await devpass.fetch(
    fakeContext({
      env,
      responses: [json({ data: { ...data, devPlanCreditsUsed: "250", devPlanPremiumWeeklyLimit: "0" } })],
    }),
  );
  assert.equal(over?.blocked, true);
  assert.equal(over?.windows.length, 1);
});

test("devpass: malformed money and resets fail closed", async () => {
  for (const patch of [
    { devPlanCreditsUsed: "-1" },
    { devPlanCreditsUsed: "1e3" },
    { devPlan: "other" },
    { devPlanPremiumWeekResetsAt: "invalid" },
  ])
    await assert.rejects(
      devpass.fetch(fakeContext({ env, responses: [json({ data: { ...fixture[0]!.data, ...patch } })] })),
      HttpError,
    );
});

test("devpass: config key and request safety", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { devpass: { apiKey: "fake-config", workspaceID: "team-1234" } },
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
  await devpass.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-config");
});
