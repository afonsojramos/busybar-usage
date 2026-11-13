import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { llmman } from "../src/providers/llmman.ts";
import { isRecord } from "../src/feed.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function fixture(name = "usage"): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`./fixtures/llmman/${name}.json`, import.meta.url), "utf8"));
  return record(value);
}

const env = { LLMMAN_API_KEY: "fake-key", LLMMAN_HOST: "https://gateway.example/prefix/v1/" };

for (const status of [401, 403]) {
  test(`llmman returns sign in for HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({ private: "never expose this" }, status)] });
    const [account] = await llmman.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
    assert.equal(account.account, "default");
  });
}

for (const retry of [null, "17"]) {
  test(`llmman honors rate limiting (${retry})`, async () => {
    const context = fakeContext({ env, responses: [json({}, 429, retry === null ? {} : { "retry-after": retry })] });
    await assert.rejects(llmman.fetch(context), (error: unknown) => {
      assert.ok(error instanceof RateLimited);
      assert.equal(error.until, NOW + (retry === null ? 300 : 17));
      return true;
    });
    assert.equal(context.calls.length, 1);
  });
}

for (const status of [400, 500]) {
  test(`llmman sanitizes HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [new Response("secret body", { status })] });
    await assert.rejects(llmman.fetch(context), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  });
}

for (const body of ["not JSON secret", "[]"]) {
  test(`llmman rejects malformed response ${body}`, async () => {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(llmman.fetch(context), HttpError);
  });
}

test("llmman rejects unsafe endpoints before sending credentials", async () => {
  for (const host of ["http://public.example", "https://user:fake@private.example", "ftp://localhost"]) {
    const context = fakeContext({ env: { ...env, LLMMAN_HOST: host } });
    await assert.rejects(llmman.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
});

test("llmman adds a deadline and refuses redirects", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
    return json({}, 401);
  };
  const [account] = await llmman.fetch(context);
  assert.equal(account.error, "sign in");
});

test("llmman reads CodexBar model memory and stored sizes", async () => {
  const context = fakeContext({ env, responses: [json(fixture()), json({ version: "test" })] });
  const [account] = await llmman.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent, w.value]),
    [["memory", 25, undefined], ["stored", null, "10.5 GB"]]);
  assert.equal(account.windows[0].minutes, null);
  assert.equal(account.windows[0].resets_at, null);
  assert.deepEqual(context.calls.map((call) => call.url), [
    "https://gateway.example/prefix/llmman/node", "https://gateway.example/prefix/api/version",
  ]);
  assert.ok(context.calls.every((call) => call.headers.authorization === "Bearer fake-key"));
});

test("llmman probes the default local daemon without a key", async () => {
  const context = fakeContext({ responses: [json(fixture()), json({}, 404)] });
  const [account] = await llmman.fetch(context);
  assert.equal(account.windows[0].used_percent, 25);
  assert.equal(context.calls[0].url, "http://127.0.0.1:17434/llmman/node");
  assert.equal(context.calls[0].headers.authorization, undefined);
});

test("llmman normalizes CLI host forms and permits private networks", async () => {
  for (const [host, origin] of [["localhost", "http://localhost:17434"], ["0.0.0.0:18000", "http://127.0.0.1:18000"],
    ["http://192.168.1.10:17434/v1", "http://192.168.1.10:17434"]]) {
    const context = fakeContext({ env: { LLMMAN_HOST: host }, responses: [json(fixture()), json({}, 404)] });
    await llmman.fetch(context);
    assert.equal(context.calls[0].url, origin + "/llmman/node");
  }
});

test("llmman handles zero memory and malformed size fields", async () => {
  const [account] = await llmman.fetch(fakeContext({ env, responses: [json({ memory: 0, loaded: {}, stored: {} }), json({}, 404)] }));
  assert.deepEqual(account.windows.map((w) => w.value), ["0 B", "0 B"]);
  for (const body of [{ memory: -1, loaded: {}, stored: {} }, { memory: 1, loaded: { a: "1" }, stored: {} },
    { memory: 1, loaded: {} }, { memory: 1, loaded: [], stored: {} }]) {
    await assert.rejects(llmman.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  }
});

test("llmman preserves cancellation during its optional version request", async () => {
  const context = fakeContext({ env });
  let calls = 0;
  const cancelled = new DOMException("cancelled", "AbortError");
  context.fetch = async () => { if (calls++ === 0) return json(fixture()); throw cancelled; };
  await assert.rejects(llmman.fetch(context), (error: unknown) => error === cancelled);
});

test("llmman preserves auth and rate limiting on the optional version endpoint", async () => {
  const [account] = await llmman.fetch(fakeContext({ env, responses: [json(fixture()), json({}, 401)] }));
  assert.equal(account.error, "sign in");
  await assert.rejects(llmman.fetch(fakeContext({ env, responses: [json(fixture()), json({}, 429)] })), RateLimited);
});

test("llmman with no address configured and nothing listening is not set up", async () => {
  const context = { ...fakeContext({}), fetch: async () => { throw new TypeError("fetch failed"); } };
  await assert.rejects(llmman.fetch(context), NotConfigured);
});
