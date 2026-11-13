import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { aixy } from "../src/providers/aixy.ts";
import { isRecord } from "../src/feed.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function fixture(name = "usage"): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`./fixtures/aixy/${name}.json`, import.meta.url), "utf8"));
  return record(value);
}

const env = { AIXY_API_KEY: "fake-key", AIXY_BASE_URL: "https://gateway.example/prefix/v1/" };

for (const status of [401, 403]) {
  test(`aixy returns sign in for HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({ private: "never expose this" }, status)] });
    const [account] = await aixy.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
    assert.equal(account.account, "default");
  });
}

for (const retry of [null, "17"]) {
  test(`aixy honors rate limiting (${retry})`, async () => {
    const context = fakeContext({ env, responses: [json({}, 429, retry === null ? {} : { "retry-after": retry })] });
    await assert.rejects(aixy.fetch(context), (error: unknown) => {
      assert.ok(error instanceof RateLimited);
      assert.equal(error.until, NOW + (retry === null ? 300 : 17));
      return true;
    });
    assert.equal(context.calls.length, 1);
  });
}

for (const status of [400, 500]) {
  test(`aixy sanitizes HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [new Response("secret body", { status })] });
    await assert.rejects(aixy.fetch(context), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  });
}

for (const body of ["not JSON secret", "[]"]) {
  test(`aixy rejects malformed response ${body}`, async () => {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(aixy.fetch(context), HttpError);
  });
}

test("aixy rejects unsafe endpoints before sending credentials", async () => {
  for (const host of ["http://public.example", "https://user:fake@private.example", "ftp://localhost"]) {
    const context = fakeContext({ env: { ...env, AIXY_BASE_URL: host } });
    await assert.rejects(aixy.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
});

test("aixy adds a deadline and refuses redirects", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
    return json({}, 401);
  };
  const [account] = await aixy.fetch(context);
  assert.equal(account.error, "sign in");
});

test("aixy skips when no key is configured", async () => {
  const context = fakeContext({ env: { AIXY_BASE_URL: env.AIXY_BASE_URL } });
  await assert.rejects(aixy.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

function budgets(body: Record<string, unknown>): Record<string, unknown>[] {
  assert.ok(Array.isArray(body.budgets));
  return body.budgets.map(record);
}

test("aixy maps CodexBar reservations and overlapping budgets independently", async () => {
  const context = fakeContext({ env, responses: [json(fixture())] });
  context.now = () => Date.parse("2026-09-24T12:00:00Z") / 1000;
  const [account] = await aixy.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.minutes, w.used_percent]),
    [["7d", 10080, 40], ["30d", 43200, 30]]);
  assert.equal(context.calls[0].url, "https://gateway.example/prefix/v1/usage");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-key");
  assert.equal(account.blocked, false);
});

test("aixy keeps zero analytics distinct from absent analytics and budgets", async () => {
  for (const spend of [0, null]) {
    const body = fixture();
    body.budgets = [];
    record(body.usage).spend_usd = spend;
    const [account] = await aixy.fetch(fakeContext({ env, responses: [json(body)] }));
    assert.deepEqual(account.windows.map((w) => w.value), spend === null ? [] : ["$0.00"]);
  }
  const body = fixture();
  body.budgets = [];
  body.usage = null;
  const [account] = await aixy.fetch(fakeContext({ env, responses: [json(body)] }));
  assert.deepEqual(account.windows, []);
});

test("aixy rejects foreign-key budgets, duplicates, bad amounts, dates and coverage", async () => {
  const patches: ((body: Record<string, unknown>) => void)[] = [
    (body) => { record(body.key).id = "different"; },
    (body) => { body.budgets = [...budgets(body), budgets(body)[0]]; },
    (body) => { budgets(body)[0].limit_usd = "NaN"; },
    (body) => { budgets(body)[0].resets_at = "invalid"; },
    (body) => { record(body.usage).attributed_requests = 13; },
    (body) => { record(body.usage).total_tokens = 1e30; },
    (body) => { body.currency = "EUR"; },
  ];
  for (const patch of patches) {
    const body = fixture();
    patch(body);
    await assert.rejects(aixy.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  }
});

test("aixy keeps lifetime budgets without an invented reset", async () => {
  const body = fixture();
  const budget = budgets(body)[0];
  Object.assign(budget, { interval: "lifetime", starts_at: null, resets_at: null });
  body.budgets = [budget];
  const context = fakeContext({ env: { AIXY_API_KEY: "fake-key" }, responses: [json(body)] });
  const [account] = await aixy.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent, w.value]),
    [["life", 30, undefined], ["spend", null, "$1.25"]]);
  assert.equal(context.calls[0].url, "https://api.aixy-gateway.com/v1/usage");
});

test("aixy detects hard exhaustion and rejects queried base URLs", async () => {
  const body = fixture();
  record(budgets(body)[0].availability).remaining_usd = "0";
  const [account] = await aixy.fetch(fakeContext({ env, responses: [json(body)] }));
  assert.equal(account.blocked, true);
  await assert.rejects(aixy.fetch(fakeContext({ env: { ...env, AIXY_BASE_URL: "https://aixy.example?probe=1" } })), NotConfigured);
});
