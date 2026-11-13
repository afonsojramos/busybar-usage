import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { bifrost } from "../src/providers/bifrost.ts";
import { isRecord } from "../src/feed.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function fixture(name = "usage"): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`./fixtures/bifrost/${name}.json`, import.meta.url), "utf8"));
  return record(value);
}

const env = { BIFROST_API_KEY: "fake-key", BIFROST_BASE_URL: "https://gateway.example/prefix/v1/" };

for (const status of [401, 403]) {
  test(`bifrost returns sign in for HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({ private: "never expose this" }, status)] });
    const [account] = await bifrost.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
    assert.equal(account.account, "default");
  });
}

for (const retry of [null, "17"]) {
  test(`bifrost honors rate limiting (${retry})`, async () => {
    const context = fakeContext({ env, responses: [json({}, 429, retry === null ? {} : { "retry-after": retry })] });
    await assert.rejects(bifrost.fetch(context), (error: unknown) => {
      assert.ok(error instanceof RateLimited);
      assert.equal(error.until, NOW + (retry === null ? 300 : 17));
      return true;
    });
    assert.equal(context.calls.length, 1);
  });
}

for (const status of [400, 500]) {
  test(`bifrost sanitizes HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [new Response("secret body", { status })] });
    await assert.rejects(bifrost.fetch(context), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  });
}

for (const body of ["not JSON secret", "[]"]) {
  test(`bifrost rejects malformed response ${body}`, async () => {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(bifrost.fetch(context), HttpError);
  });
}

test("bifrost rejects unsafe endpoints before sending credentials", async () => {
  for (const host of ["http://public.example", "https://user:fake@private.example", "ftp://localhost"]) {
    const context = fakeContext({ env: { ...env, BIFROST_BASE_URL: host } });
    await assert.rejects(bifrost.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
});

test("bifrost adds a deadline and refuses redirects", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
    return json({}, 401);
  };
  const [account] = await bifrost.fetch(context);
  assert.equal(account.error, "sign in");
});

test("bifrost skips when no key is configured", async () => {
  const context = fakeContext({ env: { BIFROST_BASE_URL: env.BIFROST_BASE_URL } });
  await assert.rejects(bifrost.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("bifrost requires a base URL", async () => {
  const context = fakeContext({ env: { BIFROST_API_KEY: "fake-key" } });
  await assert.rejects(bifrost.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("bifrost reads the CodexBar quota fixture without inventing calendar resets", async () => {
  const context = fakeContext({ env, responses: [json(fixture())] });
  const [account] = await bifrost.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.minutes, w.used_percent, w.resets_at]),
    [["1M", null, 34, null], ["1Y", null, 10, null]]);
  assert.equal(context.calls[0].url, "https://gateway.example/prefix/v1/api/governance/virtual-keys/quota");
  assert.equal(context.calls[0].headers["x-bf-vk"], "fake-key");
  assert.equal(context.calls[0].headers.authorization, undefined);
  assert.equal(account.account, "default");
});

test("bifrost uses override cycles and advances stale fixed resets", async () => {
  for (const [mode, cycles, percent] of [["cycles", 1, 50], ["cycles", 0, 100], ["forever", 0, 50]] satisfies [string, number, number][]) {
    const context = fakeContext({ env, responses: [json({ budgets: [{ id: "b", max_limit: 100, current_usage: 100,
      override_amount: 100, override_mode: mode, override_cycles_remaining: cycles,
      reset_duration: "1h30m", last_reset: new Date((NOW - 20_000) * 1000).toISOString() }] })] });
    const [account] = await bifrost.fetch(context);
    assert.equal(account.windows[0].used_percent, percent);
    assert.equal(account.windows[0].minutes, 90);
    assert.ok((account.windows[0].resets_at ?? 0) > NOW);
    assert.ok((account.windows[0].resets_at ?? Infinity) <= NOW + 5400);
  }
});

test("bifrost component rate limits supersede the compatibility merge", async () => {
  const [account] = await bifrost.fetch(fakeContext({ env, responses: [json({
    rate_limit: { request_max_limit: 100, request_current_usage: 99 },
    rate_limits: [
      { request_max_limit: 100, request_current_usage: 10, request_reset_duration: "1h" },
      { request_max_limit: 100, request_current_usage: 20, request_reset_duration: "2h" },
    ],
  })] }));
  assert.deepEqual(account.windows.map((w) => w.used_percent), [10, 20]);
});

test("bifrost falls back to singular rate limits and omits unknown counters", async () => {
  const [account] = await bifrost.fetch(fakeContext({ env, responses: [json({ rate_limits: [], rate_limit: {
    token_max_limit: 1000, token_current_usage: 500, token_reset_duration: "1h",
    request_reset_duration: "1h", request_last_reset: new Date(NOW * 1000).toISOString(),
  } })] }));
  assert.deepEqual(account.windows.map((w) => [w.minutes, w.used_percent]), [[60, 50]]);
});

test("bifrost retains unlimited spend and inactive status", async () => {
  const [account] = await bifrost.fetch(fakeContext({ env, responses: [json({
    is_active: false, budgets: [{ id: "unlimited", max_limit: 0, current_usage: 5 }],
  })] }));
  assert.equal(account.windows[0].value, "$5.00");
  assert.equal(account.blocked, true);
});

test("bifrost detects exhausted scoped quotas even when key budgets fill both lanes", async () => {
  const body = fixture();
  body.provider_configs = [{ provider: "openai", budgets: [{ id: "p", max_limit: 10, current_usage: 10 }] }];
  const [account] = await bifrost.fetch(fakeContext({ env, responses: [json(body)] }));
  assert.equal(account.windows.length, 2);
  assert.equal(account.blocked, true);
});

test("bifrost rejects invalid scalar and array shapes", async () => {
  for (const body of [{ is_active: "yes" }, { budgets: {} }, { budgets: [{ id: "b", max_limit: "5" }] },
    { budgets: [{ id: "b", max_limit: 5, override_cycles_remaining: 1.5 }] }]) {
    await assert.rejects(bifrost.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  }
});

test("bifrost selects spend from the shortest key-wide budget", async () => {
  const [account] = await bifrost.fetch(fakeContext({ env, responses: [json({ budgets: [
    { id: "year", max_limit: 0, current_usage: 100, reset_duration: "1Y" },
    { id: "month", max_limit: 0, current_usage: 5, reset_duration: "1M" },
  ] })] }));
  assert.equal(account.windows[0].value, "$5.00");
});
