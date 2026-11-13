import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { kilo } from "../src/providers/kilo.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Derived from CodexBar KiloUsageFetcherTests subscription and credit-block responses.
const entry = (data: unknown) => ({ result: { data } });
const usage = [
  entry({ creditBlocks: [{ amount_mUsd: 19000000, balance_mUsd: 9500000 }], totalBalance_mUsd: 9500000 }),
  entry({
    subscription: {
      tier: "tier_19",
      currentPeriodUsageUsd: 3.5,
      currentPeriodBaseCreditsUsd: 19,
      currentPeriodBonusCreditsUsd: 9.5,
      nextBillingAt: new Date((NOW + 3600) * 1000).toISOString(),
    },
  }),
  entry({ enabled: false, paymentMethod: null }),
];
const env = { KILO_API_KEY: "fake-api" };
const files = { "/home/test/.local/share/kilo/auth.json": JSON.stringify({ kilo: { access: "fake-cli" } }) };

test("Kilo reads credits and pass from authenticated tRPC batch", async () => {
  const context = fakeContext({ env, responses: [json(usage)] });
  const [account] = await kilo.fetch(context);
  assert.deepEqual(
    account.windows.map((window) => [window.name, window.used_percent]),
    [
      ["pass", 12],
      ["credit", 50],
    ],
  );
  assert.equal(account.windows[0].resets_at, NOW + 3600);
  assert.equal(account.account, "default");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-api");
  const url = new URL(context.calls[0].url);
  assert.equal(url.origin, "https://app.kilo.ai");
  assert.equal(url.pathname, "/api/trpc/user.getCreditBlocks,kiloPass.getState,user.getAutoTopUpPaymentMethod");
  assert.equal(url.searchParams.get("batch"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("input") ?? ""), {
    0: { json: null },
    1: { json: null },
    2: { json: null },
  });
});

test("Kilo uses CLI-owned tokens without refreshing", async () => {
  const context = fakeContext({ files, responses: [json(usage)] });
  await kilo.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-cli");
});

test("Kilo falls back to CLI only after API authentication rejection", async () => {
  for (const rejected of [json({}, 403), json([{ error: { json: { data: { code: "UNAUTHORIZED" } } } }])]) {
    const context = fakeContext({ env, files, responses: [rejected, json(usage)] });
    assert.equal((await kilo.fetch(context))[0].windows.length, 2);
    assert.deepEqual(
      context.calls.map((call) => call.headers.authorization),
      ["Bearer fake-api", "Bearer fake-cli"],
    );
  }
});

test("Kilo missing or malformed credentials are not configured", async () => {
  await assert.rejects(kilo.fetch(fakeContext({})), NotConfigured);
  for (const text of ["not json", JSON.stringify({ kilo: { access: " " } })]) {
    await assert.rejects(
      kilo.fetch(fakeContext({ files: { "/home/test/.local/share/kilo/auth.json": text } })),
      NotConfigured,
    );
  }
});

for (const status of [401, 403])
  test(`Kilo HTTP ${status} asks to sign in`, async () => {
    assert.equal((await kilo.fetch(fakeContext({ env, responses: [json({}, status)] })))[0].error, "sign in");
  });

for (const retry of [undefined, "45"])
  test(`Kilo rate limits (${retry ?? "default"})`, async () => {
    const context = fakeContext({ env, responses: [json({}, 429, retry ? { "retry-after": retry } : {})] });
    await assert.rejects(
      kilo.fetch(context),
      (error: unknown) => error instanceof RateLimited && error.until === NOW + (retry ? 45 : 300),
    );
  });

test("Kilo does not fallback on service or malformed responses", async () => {
  for (const response of [
    json({}, 500),
    json({}),
    json(null),
    json(entry({})),
    new Response("not json"),
    json([{ error: { message: "internal error" } }]),
  ]) {
    const context = fakeContext({ env, files, responses: [response] });
    await assert.rejects(kilo.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("Kilo accepts indexed entries, wrapped generic fields and optional errors", async () => {
  const context = fakeContext({
    env,
    responses: [
      json({
        0: entry({ json: { blocks: [{ usedCredits: 25, totalCredits: 100, remainingCredits: 75 }] } }),
        1: entry({
          json: { planName: "Starter", amount_mUsd: 28500000, used_mUsd: 3500000, nextRenewalAt: NOW + 3600 },
        }),
        2: { error: { message: "optional payment method unavailable" } },
      }),
    ],
  });
  assert.deepEqual(
    (await kilo.fetch(context))[0].windows.map((window) => [window.name, window.used_percent]),
    [
      ["pass", 12],
      ["credit", 25],
    ],
  );
});

test("Kilo renders unbounded balance as value and zero as exhausted", async () => {
  for (const balance of [12000000, 0]) {
    const context = fakeContext({
      env,
      responses: [json([entry({ creditBlocks: [], totalBalance_mUsd: balance }), entry({ subscription: null })])],
    });
    const [account] = await kilo.fetch(context);
    assert.equal(account.windows[0].value, balance ? "$12.00" : "$0.00");
    assert.equal(account.windows[0].used_percent, null);
    assert.equal(account.blocked, balance === 0);
  }
});

test("Kilo derives missing credit total or used", async () => {
  for (const fields of [
    { used: 25, remaining: 75 },
    { total: 100, remaining: 75 },
  ]) {
    const context = fakeContext({ env, responses: [json(entry({ json: fields }))] });
    assert.equal((await kilo.fetch(context))[0].windows[0].used_percent, 25);
  }
});

test("Kilo derives pass totals from cents and remaining", async () => {
  const context = fakeContext({
    env,
    responses: [json([entry({ total: 0, used: 0 }), entry({ usedCents: 500, remainingCents: 1500 })])],
  });
  const [account] = await kilo.fetch(context);
  assert.equal(account.windows[0].used_percent, 25);
  assert.equal(account.windows[1].used_percent, 100);
  assert.equal(account.blocked, true);
});

test("Kilo handles large finite balances and omits overflowed quota totals", async () => {
  const context = fakeContext({
    env,
    responses: [
      json([
        entry({ totalBalance_mUsd: 1e30 }),
        entry({
          subscription: {
            currentPeriodUsageUsd: 1,
            currentPeriodBaseCreditsUsd: 1.7e308,
            currentPeriodBonusCreditsUsd: 1.7e308,
          },
        }),
      ]),
    ],
  });
  const [account] = await kilo.fetch(context);
  assert.equal(account.windows.length, 1);
  assert.ok((account.windows[0].value ?? "").length <= 12);
});

test("Kilo does not block a small positive balance rounded to zero dollars", async () => {
  const context = fakeContext({ env, responses: [json(entry({ totalBalance_mUsd: 100 }))] });
  assert.equal((await kilo.fetch(context))[0].blocked, false);
});

test("Kilo passes a request timeout signal", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return json(usage);
  };
  await kilo.fetch(context);
});

test("Kilo uses the subscription renewal instead of outer bonus expiry", async () => {
  const context = fakeContext({
    env,
    responses: [
      json([
        entry({ totalBalance_mUsd: 1000000 }),
        entry({
          expiresAt: NOW - 100,
          subscription: {
            currentPeriodUsageUsd: 19,
            currentPeriodBaseCreditsUsd: 19,
            nextBillingAt: new Date((NOW + 3600) * 1000).toISOString(),
          },
        }),
      ]),
    ],
  });
  const [account] = await kilo.fetch(context);
  assert.equal(account.windows[0].resets_at, NOW + 3600);
  assert.equal(account.windows[0].used_percent, 100);
  assert.equal(account.blocked, true);
});
