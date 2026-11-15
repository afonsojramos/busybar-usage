import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mimo } from "../src/providers/mimo.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const config = {
  "/home/test/.config/busybar-usage/config.json": JSON.stringify({
    providers: {
      mimo: {
        cookieHeader: "userId=fake-user; api-platform_serviceToken=fake-token; api-platform_ph=fake-ph; ignored=value",
      },
    },
  }),
};
// Adapted from CodexBar MiMoProviderTests balance and token-plan payloads.
const balance = { code: 0, data: { balance: "25.51", currency: "USD", cashBalance: "20", giftBalance: "5.51" } };
const detail = { code: 0, data: { planCode: "standard", currentPeriodEnd: "2027-05-04 23:59:59", expired: false } };
const usage = {
  code: 0,
  data: {
    monthUsage: {
      percent: 0.0505,
      items: [{ name: "Credits", used: 10_100_158, limit: 200_000_000, percent: 0.0505 }],
    },
  },
};
const cache = JSON.stringify({
  updated_at: new Date((NOW - 60) * 1000).toISOString(),
  windows: {
    today: { input: 100, output: 200, cache_read: 50, cache_create: 25 },
    week: { input: 1000, output: 2000 },
    all_time: { input: 10000 },
  },
});

test("MiMo reads plan and balance using filtered browser cookie headers", async () => {
  const ctx = fakeContext({ files: config, responses: [json(balance), json(detail), json(usage)] });
  const [account] = await mimo.fetch(ctx);
  assert.equal(account.account, "default");
  assert.equal(account.windows[0].name, "30d");
  assert.equal(account.windows[0].minutes, 43200);
  assert.equal(account.windows[0].used_percent, 5);
  assert.equal(account.windows[0].resets_at, Date.parse("2027-05-04T23:59:59Z") / 1000);
  assert.equal(account.windows[1].value, "$25.51");
  assert.deepEqual(
    ctx.calls.map((call) => call.url),
    ["balance", "tokenPlan/detail", "tokenPlan/usage"].map((path) => `https://platform.xiaomimimo.com/api/v1/${path}`),
  );
  assert.equal(
    ctx.calls[0].headers.cookie,
    "api-platform_ph=fake-ph; api-platform_serviceToken=fake-token; userId=fake-user",
  );
  assert.equal(ctx.calls[0].headers["x-timezone"], "UTC+01:00");
});

test("MiMo missing session and cache is not configured", async () => {
  await assert.rejects(mimo.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403, 302]) {
  test(`MiMo ${status} requests sign in`, async () => {
    const ctx = fakeContext({ files: config, responses: [new Response(null, { status })] });
    assert.equal((await mimo.fetch(ctx))[0].error, "sign in");
    assert.equal(ctx.calls.length, 1);
  });
}

test("MiMo 429 preserves Retry-After", async () => {
  await assert.rejects(
    mimo.fetch(fakeContext({ files: config, responses: [json({}, 429, { "retry-after": "60" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 60,
  );
});

for (const body of [
  "not json",
  JSON.stringify({ code: 0, data: { balance: "nan", currency: "USD" } }),
  JSON.stringify({ code: 20, data: {} }),
  JSON.stringify({}),
]) {
  test(`MiMo rejects malformed balance ${body}`, async () => {
    await assert.rejects(mimo.fetch(fakeContext({ files: config, responses: [new Response(body)] })), HttpError);
  });
}

test("MiMo handles application-level expired session", async () => {
  assert.equal(
    (await mimo.fetch(fakeContext({ files: config, responses: [json({ code: 401 })] })))[0].error,
    "sign in",
  );
});

test("MiMo optional failures retain balance", async () => {
  const [account] = await mimo.fetch(
    fakeContext({ files: config, responses: [json(balance), json({}, 500), new Response("bad")] }),
  );
  assert.deepEqual(
    account.windows.map((window) => window.value),
    ["$25.51"],
  );
});

test("MiMo unknown reset does not invent monthly cadence; full plan is blocked", async () => {
  const [account] = await mimo.fetch(
    fakeContext({
      files: config,
      responses: [
        json(balance),
        json({ code: 0, data: {} }),
        json({ code: 0, data: { monthUsage: { items: [{ limit: 100, percent: 1 }] } } }),
      ],
    }),
  );
  assert.equal(account.windows[0].minutes, null);
  assert.equal(account.windows[0].name, "credit");
  assert.equal(account.blocked, true);
});

test("MiMo reads local cache without presenting counters as quotas", async () => {
  const ctx = fakeContext({ files: { "/home/test/.codexbar/mimo-local-usage.json": cache } });
  const [account] = await mimo.fetch(ctx);
  assert.equal(account.observed_at, new Date((NOW - 60) * 1000).toISOString());
  assert.deepEqual(
    account.windows.map((window) => window.value),
    ["375 tok", "3.0k tok"],
  );
  assert.ok(account.windows.every((window) => window.used_percent === null));
  assert.equal(ctx.calls.length, 0);
});

test("MiMo expands custom local cache path without a session", async () => {
  const [account] = await mimo.fetch(
    fakeContext({ env: { MIMO_LOCAL_USAGE_PATH: "~/cache.json" }, files: { "/home/test/cache.json": cache } }),
  );
  assert.equal(account.error, undefined);
  assert.equal(account.windows[0].value, "375 tok");
});

test("MiMo malformed local cache fails visibly", async () => {
  await assert.rejects(
    mimo.fetch(fakeContext({ files: { "/home/test/.codexbar/mimo-local-usage.json": "{}" } })),
    HttpError,
  );
});

for (const endpoint of [
  "http://platform.xiaomimimo.com/api/v1",
  "https://evil.invalid/api/v1",
  "https://platform.xiaomimimo.com:444/api/v1",
]) {
  test(`MiMo rejects unsafe override ${endpoint}`, async () => {
    const ctx = fakeContext({ files: config, env: { MIMO_API_URL: endpoint } });
    await assert.rejects(mimo.fetch(ctx), NotConfigured);
    assert.equal(ctx.calls.length, 0);
  });
}

test("MiMo sends a timeout and prevents redirects from forwarding cookies", async () => {
  const ctx = fakeContext({ files: config });
  ctx.fetch = async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.redirect, "manual");
    return json({}, 401);
  };
  assert.equal((await mimo.fetch(ctx))[0].error, "sign in");
});

test("MiMo rate limit fallback is five minutes", async () => {
  await assert.rejects(
    mimo.fetch(fakeContext({ files: config, responses: [json({}, 429)] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300,
  );
});

test("MiMo server failure does not hide behind local accounting or leak the response", async () => {
  const ctx = fakeContext({
    files: { ...config, "/home/test/.codexbar/mimo-local-usage.json": cache },
    responses: [new Response("secret-response-body", { status: 503 })],
  });
  await assert.rejects(
    mimo.fetch(ctx),
    (error: unknown) =>
      error instanceof HttpError && error.status === 503 && !error.message.includes("secret-response-body"),
  );
});

test("MiMo invalid override does not fall back to local accounting", async () => {
  const ctx = fakeContext({
    env: { MIMO_API_URL: "https://untrusted.invalid" },
    files: { "/home/test/.codexbar/mimo-local-usage.json": cache },
  });
  await assert.rejects(mimo.fetch(ctx), NotConfigured);
});

test("MiMo auth rejection requires sign in even when local cache exists", async () => {
  const [account] = await mimo.fetch(
    fakeContext({
      files: { ...config, "/home/test/.codexbar/mimo-local-usage.json": cache },
      responses: [json({}, 401)],
    }),
  );
  assert.equal(account.error, "sign in");
});

test("MiMo large local counters remain within the display value limit", async () => {
  const data = JSON.parse(cache);
  data.windows.today.input = 1e20;
  data.windows.week.input = 1e308;
  const [account] = await mimo.fetch(
    fakeContext({ files: { "/home/test/.codexbar/mimo-local-usage.json": JSON.stringify(data) } }),
  );
  assert.ok(account.windows.every((window) => (window.value?.length ?? 0) <= 12));
});
