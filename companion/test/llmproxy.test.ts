import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { llmproxy } from "../src/providers/llmproxy.ts";
import { isRecord } from "../src/feed.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function fixture(name = "usage"): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`./fixtures/llmproxy/${name}.json`, import.meta.url), "utf8"));
  return record(value);
}

const env = { LLM_PROXY_API_KEY: "fake-key", LLM_PROXY_BASE_URL: "https://gateway.example/prefix/v1/" };

for (const status of [401, 403]) {
  test(`llmproxy returns sign in for HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({ private: "never expose this" }, status)] });
    const [account] = await llmproxy.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
    assert.equal(account.account, "default");
  });
}

for (const retry of [null, "17"]) {
  test(`llmproxy honors rate limiting (${retry})`, async () => {
    const context = fakeContext({ env, responses: [json({}, 429, retry === null ? {} : { "retry-after": retry })] });
    await assert.rejects(llmproxy.fetch(context), (error: unknown) => {
      assert.ok(error instanceof RateLimited);
      assert.equal(error.until, NOW + (retry === null ? 300 : 17));
      return true;
    });
    assert.equal(context.calls.length, 1);
  });
}

for (const status of [400, 500]) {
  test(`llmproxy sanitizes HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [new Response("secret body", { status })] });
    await assert.rejects(llmproxy.fetch(context), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  });
}

for (const body of ["not JSON secret", "[]"]) {
  test(`llmproxy rejects malformed response ${body}`, async () => {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(llmproxy.fetch(context), HttpError);
  });
}

test("llmproxy rejects unsafe endpoints before sending credentials", async () => {
  for (const host of ["http://public.example", "https://user:fake@private.example", "ftp://localhost"]) {
    const context = fakeContext({ env: { ...env, LLM_PROXY_BASE_URL: host } });
    await assert.rejects(llmproxy.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
});

test("llmproxy adds a deadline and refuses redirects", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
    return json({}, 401);
  };
  const [account] = await llmproxy.fetch(context);
  assert.equal(account.error, "sign in");
});

test("llmproxy skips when no key is configured", async () => {
  const context = fakeContext({ env: { LLM_PROXY_BASE_URL: env.LLM_PROXY_BASE_URL } });
  await assert.rejects(llmproxy.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("llmproxy requires a base URL", async () => {
  const context = fakeContext({ env: { LLM_PROXY_API_KEY: "fake-key" } });
  await assert.rejects(llmproxy.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("llmproxy reads CodexBar object and array quota groups", async () => {
  const context = fakeContext({ env, responses: [json(fixture())] });
  context.now = () => Date.parse("2026-05-15T00:00:00Z") / 1000;
  const [account] = await llmproxy.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent, w.value]),
    [["quota", 58, undefined], ["spend", null, "$15.50"]]);
  assert.equal(account.windows[0].minutes, null);
  assert.equal(account.windows[0].resets_at, Date.parse("2026-05-18T12:00:00Z") / 1000);
  assert.equal(context.calls[0].url, "https://gateway.example/prefix/v1/quota-stats");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-key");
});

test("llmproxy tolerates malformed optional groups and sums provider cost", async () => {
  const context = fakeContext({ env, responses: [json({ providers: {
    a: { approx_cost: 2, total_requests: 3, quota_groups: "invalid" },
    b: { approx_cost: 3, quota_groups: [{ remaining_percent: -10, reset_time: "1970-01-01T00:00:00Z" }] },
  } })] });
  const [account] = await llmproxy.fetch(context);
  assert.equal(account.windows[0].used_percent, 100);
  assert.equal(account.windows[0].resets_at, null);
  assert.equal(account.windows[1].value, "$5.00");
  assert.equal(account.blocked, true);
});

test("llmproxy distinguishes explicit zero cost from unknown spend", async () => {
  const [zero] = await llmproxy.fetch(fakeContext({ env, responses: [json({ providers: {}, summary: { approx_cost: 0 } })] }));
  assert.equal(zero.windows[0].value, "$0.00");
  const [unknown] = await llmproxy.fetch(fakeContext({ env, responses: [json({ providers: {} })] }));
  assert.equal(unknown.windows[0].name, "reqs");
});

test("llmproxy resolves CodexBar config and private network URLs", async () => {
  for (const host of ["http://10.1.2.3:8080", "http://172.16.1.2", "http://192.168.1.2", "http://proxy.local", "http://[fd00::1]:8080", "http://[fe80::1]"]) {
    const context = fakeContext({ files: { "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [
      { id: "llmproxy", apiKey: "fake-key", enterpriseHost: host },
    ] }) }, responses: [json({ providers: {} })] });
    await llmproxy.fetch(context);
    assert.equal(new URL(context.calls[0].url).origin, new URL(host).origin);
  }
});

test("llmproxy rejects malformed required fields", async () => {
  for (const body of [{}, { providers: { a: { total_requests: "3" } } }, { providers: {}, summary: { approx_cost: "5" } }]) {
    await assert.rejects(llmproxy.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  }
});
