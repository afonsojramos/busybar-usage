import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { sub2api } from "../src/providers/sub2api.ts";
import { isRecord } from "../src/feed.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function fixture(name = "usage"): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`./fixtures/sub2api/${name}.json`, import.meta.url), "utf8"));
  return record(value);
}

const env = { SUB2API_API_KEY: "fake-key", SUB2API_BASE_URL: "https://gateway.example/prefix/v1/" };

for (const status of [401, 403]) {
  test(`sub2api returns sign in for HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({ private: "never expose this" }, status)] });
    const [account] = await sub2api.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
    assert.equal(account.account, "default");
  });
}

for (const retry of [null, "17"]) {
  test(`sub2api honors rate limiting (${retry})`, async () => {
    const context = fakeContext({ env, responses: [json({}, 429, retry === null ? {} : { "retry-after": retry })] });
    await assert.rejects(sub2api.fetch(context), (error: unknown) => {
      assert.ok(error instanceof RateLimited);
      assert.equal(error.until, NOW + (retry === null ? 300 : 17));
      return true;
    });
    assert.equal(context.calls.length, 1);
  });
}

for (const status of [400, 500]) {
  test(`sub2api sanitizes HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [new Response("secret body", { status })] });
    await assert.rejects(sub2api.fetch(context), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  });
}

for (const body of ["not JSON secret", "[]"]) {
  test(`sub2api rejects malformed response ${body}`, async () => {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(sub2api.fetch(context), HttpError);
  });
}

test("sub2api rejects unsafe endpoints before sending credentials", async () => {
  for (const host of ["http://public.example", "https://user:fake@private.example", "ftp://localhost"]) {
    const context = fakeContext({ env: { ...env, SUB2API_BASE_URL: host } });
    await assert.rejects(sub2api.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
});

test("sub2api adds a deadline and refuses redirects", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
    return json({}, 401);
  };
  const [account] = await sub2api.fetch(context);
  assert.equal(account.error, "sign in");
});

test("sub2api skips when no key is configured", async () => {
  const context = fakeContext({ env: { SUB2API_BASE_URL: env.SUB2API_BASE_URL } });
  await assert.rejects(sub2api.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("sub2api requires a base URL", async () => {
  const context = fakeContext({ env: { SUB2API_API_KEY: "fake-key" } });
  await assert.rejects(sub2api.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("sub2api maps CodexBar quota and rate limits shortest first", async () => {
  const context = fakeContext({ env, responses: [json(fixture())] });
  context.now = () => Date.parse("2026-07-10T00:00:00Z") / 1000;
  const [account] = await sub2api.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.minutes, w.used_percent]),
    [
      ["5h", 300, 25],
      ["7d", 10080, 20],
    ],
  );
  assert.equal(account.blocked, false);
  const url = new URL(context.calls[0].url);
  assert.equal(url.pathname, "/prefix/v1/usage");
  assert.equal(url.searchParams.get("days"), "30");
  assert.equal(url.searchParams.get("timezone"), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-key");
});

test("sub2api keeps daily and weekly subscription counters", async () => {
  const [account] = await sub2api.fetch(fakeContext({ env, responses: [json(fixture("subscription"))] }));
  assert.deepEqual(
    account.windows.map((w) => [w.minutes, w.used_percent]),
    [
      [1440, 20],
      [10080, 25],
    ],
  );
  assert.ok(account.windows.every((w) => w.resets_at === null));
});

test("sub2api reports wallet balance with no invented quota", async () => {
  const [account] = await sub2api.fetch(fakeContext({ env, responses: [json(fixture("wallet"))] }));
  assert.equal(account.windows.length, 1);
  assert.equal(account.windows[0].value, "$42.50");
  assert.equal(account.windows[0].used_percent, null);
});

test("sub2api remembers exhaustion in a dropped lane", async () => {
  const body = fixture("subscription");
  record(body.subscription).monthly_usage_usd = 100;
  const [account] = await sub2api.fetch(fakeContext({ env, responses: [json(body)] }));
  assert.equal(account.windows.length, 2);
  assert.equal(account.blocked, true);
});

test("sub2api treats isValid false as an expired login", async () => {
  const [account] = await sub2api.fetch(fakeContext({ env, responses: [json({ isValid: false })] }));
  assert.equal(account.error, "sign in");
});

test("sub2api accepts complete usage URLs and rejects non-loopback HTTP", async () => {
  for (const suffix of ["", "/v1", "/v1/usage"]) {
    const context = fakeContext({
      env: { ...env, SUB2API_BASE_URL: "http://127.0.0.1:8080" + suffix },
      responses: [json(fixture("wallet"))],
    });
    await sub2api.fetch(context);
    assert.equal(new URL(context.calls[0].url).pathname, "/v1/usage");
  }
  for (const host of ["http://192.168.1.2", "https://example.test?probe=1", "https://example.test#probe"]) {
    await assert.rejects(sub2api.fetch(fakeContext({ env: { ...env, SUB2API_BASE_URL: host } })), NotConfigured);
  }
});

test("sub2api rejects incomplete quota and malformed reset data", async () => {
  for (const body of [
    { quota: { used: 2 } },
    { subscription: { daily_usage_usd: "2" } },
    { rate_limits: [{ window: "5h", used: 2, limit: 10, remaining: 8, reset_at: "invalid" }] },
  ]) {
    await assert.rejects(sub2api.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  }
});

test("sub2api cannot interpret prototype keys as window lengths", async () => {
  const [account] = await sub2api.fetch(
    fakeContext({
      env,
      responses: [json({ rate_limits: [{ window: "constructor", used: 1, limit: 10, remaining: 9 }] })],
    }),
  );
  assert.equal(account.windows[0].minutes, null);
  assert.equal(account.windows[0].used_percent, 10);
});
