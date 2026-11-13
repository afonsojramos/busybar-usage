import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { wayfinder } from "../src/providers/wayfinder.ts";
import { isRecord } from "../src/feed.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function fixture(name = "usage"): Record<string, unknown> {
  const value: unknown = JSON.parse(
    readFileSync(new URL(`./fixtures/wayfinder/${name}.json`, import.meta.url), "utf8"),
  );
  return record(value);
}

const env = { WAYFINDER_GATEWAY_URL: "https://gateway.example/prefix/v1/" };

for (const status of [401, 403]) {
  test(`wayfinder returns sign in for HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({ private: "never expose this" }, status)] });
    const [account] = await wayfinder.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
    assert.equal(account.account, "default");
  });
}

for (const retry of [null, "17"]) {
  test(`wayfinder honors rate limiting (${retry})`, async () => {
    const context = fakeContext({ env, responses: [json({}, 429, retry === null ? {} : { "retry-after": retry })] });
    await assert.rejects(wayfinder.fetch(context), (error: unknown) => {
      assert.ok(error instanceof RateLimited);
      assert.equal(error.until, NOW + (retry === null ? 300 : 17));
      return true;
    });
    assert.equal(context.calls.length, 1);
  });
}

for (const status of [400, 500]) {
  test(`wayfinder sanitizes HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [new Response("secret body", { status })] });
    await assert.rejects(wayfinder.fetch(context), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  });
}

for (const body of ["not JSON secret", "[]"]) {
  test(`wayfinder rejects malformed response ${body}`, async () => {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(wayfinder.fetch(context), HttpError);
  });
}

test("wayfinder rejects unsafe endpoints before sending credentials", async () => {
  for (const host of ["http://public.example", "https://user:fake@private.example", "ftp://localhost"]) {
    const context = fakeContext({ env: { ...env, WAYFINDER_GATEWAY_URL: host } });
    await assert.rejects(wayfinder.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
});

test("wayfinder adds a deadline and refuses redirects", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
    return json({}, 401);
  };
  const [account] = await wayfinder.fetch(context);
  assert.equal(account.error, "sign in");
});

function responses(savings = "savings30d", metrics = new Response("metrics")) {
  return [json(fixture("healthOK")), json(fixture("models")), json(fixture(savings)), metrics];
}

test("wayfinder reads CodexBar's captured local gateway responses", async () => {
  const context = fakeContext({ responses: responses() });
  const [account] = await wayfinder.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent, w.value]),
    [
      ["saved", null, "<$0.01"],
      ["reqs", null, "14"],
    ],
  );
  assert.deepEqual(
    context.calls.map((call) => new URL(call.url).pathname),
    ["/healthz", "/router/models", "/v1/savings", "/metrics"],
  );
  assert.equal(new URL(context.calls[2].url).search, "?period=30d");
  assert.equal(new URL(context.calls[0].url).origin, "http://127.0.0.1:8088");
  assert.ok(context.calls.every((call) => call.headers.authorization === undefined));
});

test("wayfinder never presents relative savings as dollars", async () => {
  const [account] = await wayfinder.fetch(fakeContext({ env, responses: responses("savingsUnpriced") }));
  assert.equal(account.windows[0].value, "40.0%");
  assert.equal(account.blocked, false);
});

test("wayfinder tolerates unavailable metrics and zero traffic", async () => {
  const context = fakeContext({
    env,
    responses: responses("savingsZeros", new Response("unavailable", { status: 503 })),
  });
  const [account] = await wayfinder.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => w.value),
    ["$0.00", "0"],
  );
});

test("wayfinder supports configured path prefixes and rejects remote HTTP", async () => {
  const context = fakeContext({
    env: { WAYFINDER_GATEWAY_URL: "https://wayfinder.example/wf/" },
    responses: responses(),
  });
  await wayfinder.fetch(context);
  assert.equal(context.calls[0].url, "https://wayfinder.example/wf/healthz");
  await assert.rejects(
    wayfinder.fetch(fakeContext({ env: { WAYFINDER_GATEWAY_URL: "http://192.168.1.5" } })),
    NotConfigured,
  );
});

test("wayfinder validates required models and savings bodies", async () => {
  for (const replies of [
    [json({})],
    [json(fixture("healthOK")), json({ models: [] })],
    [json(fixture("healthOK")), json(fixture("models")), json({})],
  ]) {
    await assert.rejects(wayfinder.fetch(fakeContext({ env, responses: replies })), HttpError);
  }
});

test("wayfinder preserves cancellation from metrics", async () => {
  const context = fakeContext({ env });
  const replies = responses();
  const cancelled = new DOMException("cancelled", "AbortError");
  let calls = 0;
  context.fetch = async () => {
    if (calls++ === 3) throw cancelled;
    return replies.shift() ?? json({});
  };
  await assert.rejects(wayfinder.fetch(context), (error: unknown) => error === cancelled);
});

test("wayfinder preserves auth and rate limiting on optional metrics", async () => {
  const [account] = await wayfinder.fetch(fakeContext({ env, responses: responses("savings30d", json({}, 401)) }));
  assert.equal(account.error, "sign in");
  await assert.rejects(
    wayfinder.fetch(fakeContext({ env, responses: responses("savings30d", json({}, 429)) })),
    RateLimited,
  );
});

test("Wayfinder with no address configured and nothing listening is not set up", async () => {
  const context = {
    ...fakeContext({}),
    fetch: async () => {
      throw new TypeError("fetch failed");
    },
  };
  await assert.rejects(wayfinder.fetch(context), NotConfigured);
});
