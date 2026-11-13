import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { clawrouter } from "../src/providers/clawrouter.ts";
import { isRecord } from "../src/feed.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function fixture(name = "usage"): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`./fixtures/clawrouter/${name}.json`, import.meta.url), "utf8"));
  return record(value);
}

const env = { CLAWROUTER_API_KEY: "fake-key", CLAWROUTER_BASE_URL: "https://gateway.example/prefix/v1/" };

for (const status of [401, 403]) {
  test(`clawrouter returns sign in for HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({ private: "never expose this" }, status)] });
    const [account] = await clawrouter.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
    assert.equal(account.account, "default");
  });
}

for (const retry of [null, "17"]) {
  test(`clawrouter honors rate limiting (${retry})`, async () => {
    const context = fakeContext({ env, responses: [json({}, 429, retry === null ? {} : { "retry-after": retry })] });
    await assert.rejects(clawrouter.fetch(context), (error: unknown) => {
      assert.ok(error instanceof RateLimited);
      assert.equal(error.until, NOW + (retry === null ? 300 : 17));
      return true;
    });
    assert.equal(context.calls.length, 1);
  });
}

for (const status of [400, 500]) {
  test(`clawrouter sanitizes HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [new Response("secret body", { status })] });
    await assert.rejects(clawrouter.fetch(context), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  });
}

for (const body of ["not JSON secret", "[]"]) {
  test(`clawrouter rejects malformed response ${body}`, async () => {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(clawrouter.fetch(context), HttpError);
  });
}

test("clawrouter rejects unsafe endpoints before sending credentials", async () => {
  for (const host of ["http://public.example", "https://user:fake@private.example", "ftp://localhost"]) {
    const context = fakeContext({ env: { ...env, CLAWROUTER_BASE_URL: host } });
    await assert.rejects(clawrouter.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
});

test("clawrouter adds a deadline and refuses redirects", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
    return json({}, 401);
  };
  const [account] = await clawrouter.fetch(context);
  assert.equal(account.error, "sign in");
});

test("clawrouter skips when no key is configured", async () => {
  const context = fakeContext({ env: { CLAWROUTER_BASE_URL: env.CLAWROUTER_BASE_URL } });
  await assert.rejects(clawrouter.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("clawrouter reads the CodexBar monthly fixture", async () => {
  const context = fakeContext({ env, responses: [json(fixture())] });
  context.now = () => Date.parse("2026-07-15T00:00:00Z") / 1000;
  const [account] = await clawrouter.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.minutes, w.used_percent, w.value]),
    [["30d", 43200, 0, undefined], ["spend", null, null, "$0.01"]]);
  assert.equal(account.windows[0].resets_at, Date.parse("2026-08-01T00:00:00Z") / 1000);
  assert.equal(context.calls[0].url, "https://gateway.example/prefix/v1/usage");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-key");
});

test("clawrouter supports hosted defaults, config keys and unmetered policies", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({
    providers: { clawrouter: { apiKey: "fake-key" } },
  }) }, responses: [json(fixture("unmetered"))] });
  const [account] = await clawrouter.fetch(context);
  assert.deepEqual(account.windows.map((w) => w.value), ["$1.25"]);
  assert.equal(context.calls[0].url, "https://clawrouter.openclaw.ai/v1/usage");
});

test("clawrouter handles exhausted budgets and year rollover", async () => {
  const body = fixture();
  Object.assign(record(body.budget), { windowKey: "policy/2026-12", spentMicros: 25_000_000, remainingMicros: 0 });
  const context = fakeContext({ env, responses: [json(body)] });
  const [account] = await clawrouter.fetch(context);
  assert.equal(account.blocked, true);
  assert.equal(account.windows[0].used_percent, 100);
  assert.equal(account.windows[0].resets_at, Date.parse("2027-01-01T00:00:00Z") / 1000);
});

test("clawrouter rejects fractional micro amounts and invalid months", async () => {
  for (const patch of [{ spentMicros: 1.5 }, { windowKey: "policy/2026-99" }]) {
    const body = fixture();
    Object.assign(record(body.budget), patch);
    await assert.rejects(clawrouter.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  }
});
