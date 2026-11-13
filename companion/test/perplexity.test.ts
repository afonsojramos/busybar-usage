import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { perplexity } from "../src/providers/perplexity.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { PERPLEXITY_COOKIE: "__Secure-authjs.session-token=fake-session" };
const usage = {
  balance_cents: 7250,
  renewal_date_ts: NOW + 86400,
  current_period_purchased_cents: 0,
  total_usage_cents: 2750,
  credit_grants: [
    { type: "recurring", amount_cents: 10000, expires_at_ts: NOW + 86400 },
    { type: "promotional", amount_cents: 20000, expires_at_ts: NOW + 86400 },
  ],
};

test("Perplexity maps CodexBar recurring and promotional credit fixture", async () => {
  const context = fakeContext({ env, responses: [json(usage)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal);
    assert.equal(init?.redirect, "manual");
    return fetch(input, init);
  };
  const [account] = await perplexity.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.minutes, w.used_percent]),
    [
      ["Credits", null, 28],
      ["Bonus", null, 0],
    ],
  );
  assert.equal(context.calls[0].url, "https://www.perplexity.ai/rest/billing/credits?version=2.18&source=default");
  assert.equal(context.calls[0].headers.cookie, env.PERPLEXITY_COOKIE);
  assert.equal(context.calls[0].headers.origin, "https://www.perplexity.ai");
  assert.equal(context.calls[0].headers.referer, "https://www.perplexity.ai/account/usage");
});

test("Perplexity missing session is not configured", async () => {
  await assert.rejects(perplexity.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`Perplexity ${status} asks to sign in`, async () => {
    const [account] = await perplexity.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account.error, "sign in");
  });
}

test("Perplexity honors Retry-After", async () => {
  await assert.rejects(
    perplexity.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "17" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 17,
  );
});

test("Perplexity tries four cookie names for bare token in CodexBar order", async () => {
  const context = fakeContext({
    env: { PERPLEXITY_SESSION_TOKEN: "fake-bare" },
    responses: [json({}, 401), json({}, 403), json(usage)],
  });
  await perplexity.fetch(context);
  assert.deepEqual(
    context.calls.map((call) => call.headers.cookie),
    [
      "__Secure-authjs.session-token=fake-bare",
      "authjs.session-token=fake-bare",
      "__Secure-next-auth.session-token=fake-bare",
    ],
  );
});

test("Perplexity joins contiguous session chunks and reads saved config", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: {
          perplexity: {
            cookieHeader: "Cookie: next-auth.session-token.1=two; next-auth.session-token.0=one; other=ignored",
          },
        },
      }),
    },
    responses: [json(usage)],
  });
  await perplexity.fetch(context);
  assert.equal(context.calls[0].headers.cookie, "next-auth.session-token=onetwo");
});

test("Perplexity waterfall promotes remaining bonus after recurring and purchased pools", async () => {
  const [account] = await perplexity.fetch(
    fakeContext({
      env,
      responses: [
        json({
          ...usage,
          balance_cents: 3000,
          total_usage_cents: 9000,
          current_period_purchased_cents: 3000,
          credit_grants: [
            { type: "recurring", amount_cents: 5000 },
            { type: "promotional", amount_cents: 4000 },
          ],
        }),
      ],
    }),
  );
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent]),
    [
      ["Bonus", 25],
      ["Credits", 100],
    ],
  );
  assert.equal(account.blocked, true);
});

test("Perplexity expired promotions are omitted and camelCase fields work", async () => {
  const [account] = await perplexity.fetch(
    fakeContext({
      env,
      responses: [
        json({
          balanceCents: 100,
          renewalDateTs: NOW + 100,
          currentPeriodPurchasedCents: 200,
          totalUsageCents: 100,
          creditGrants: [{ type: "promotional", amountCents: 500, expiresAtTs: NOW - 1 }],
        }),
      ],
    }),
  );
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent]),
    [["Bought", 50]],
  );
});

test("Perplexity organization available credits do not include the member cap", async () => {
  const [account] = await perplexity.fetch(
    fakeContext({
      env,
      responses: [
        json({
          ...usage,
          balance_cents: 3342.28,
          total_usage_cents: 24870.74,
          org_pool_draws_cents: 24371,
          org_user_cap_cents: 300000,
          is_org_pool_depleted: false,
          credit_grants: [{ type: "recurring", amount_cents: 500 }],
        }),
      ],
    }),
  );
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent]),
    [
      ["Org", 88],
      ["Credits", 100],
    ],
  );
});

for (const response of [
  json({}),
  new Response("not JSON"),
  json({ ...usage, total_usage_cents: "secret" }),
  json({}, 500),
]) {
  test(`Perplexity invalid response ${response.status} is sanitized`, async () => {
    await assert.rejects(perplexity.fetch(fakeContext({ env, responses: [response] })), HttpError);
  });
}
