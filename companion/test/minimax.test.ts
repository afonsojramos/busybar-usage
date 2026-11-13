import assert from "node:assert/strict";
import { test } from "node:test";
import { minimax } from "../src/providers/minimax.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Derived from CodexBar MiniMaxAPITokenFetchTests and MiniMaxModelRemains fixtures.
const model = {
  model_name: "MiniMax-M2", current_interval_total_count: 1000, current_interval_usage_count: 250,
  start_time: NOW * 1000, end_time: (NOW + 18000) * 1000, remains_time: 240000,
  current_weekly_total_count: 10000, current_weekly_usage_count: 4000,
  weekly_start_time: NOW * 1000, weekly_end_time: (NOW + 604800) * 1000,
};
const usage = (overrides = {}) => ({ base_resp: { status_code: 0 }, model_remains: [{ ...model, ...overrides }] });
const env = { MINIMAX_CODING_API_KEY: "sk-cp-fake" };

test("MiniMax maps remaining counts to five-hour and weekly usage", async () => {
  const context = fakeContext({ env: { ...env, MINIMAX_API_KEY: "sk-api-unused" }, responses: [json(usage())] });
  const [account] = await minimax.fetch(context);
  assert.deepEqual(account.windows.map((window) => [window.name, window.minutes, window.used_percent]), [["5h", 300, 75], ["7d", 10080, 60]]);
  assert.equal(account.account, "default");
  assert.equal(account.blocked, false);
  assert.equal(context.calls[0].url, "https://api.minimax.io/v1/token_plan/remains");
  assert.equal(context.calls[0].headers.authorization, "Bearer sk-cp-fake");
  assert.equal(context.calls[0].headers["mm-api-source"], "CodexBar");
});

test("MiniMax accepts wrapped data, percent strings and boosted denominators", async () => {
  const context = fakeContext({ env, responses: [json({ data: usage({ current_interval_remaining_percent: undefined, current_interval_used_percent: "40%", current_interval_total_percent: "200%" }) })] });
  assert.equal((await minimax.fetch(context))[0].windows[0].used_percent, 20);
});

test("MiniMax uses remaining percentages and fallback reset durations", async () => {
  const context = fakeContext({ env, responses: [json(usage({ current_interval_remaining_percent: 0, start_time: (NOW - 18001) * 1000, end_time: (NOW - 1) * 1000, remains_time: 2000000 }))] });
  const [account] = await minimax.fetch(context);
  assert.equal(account.windows[0].used_percent, 100);
  assert.equal(account.windows[0].resets_at, NOW + 2000);
  assert.equal(account.blocked, true);
});

test("MiniMax keeps unlimited weekly text without a percent bar", async () => {
  const context = fakeContext({ env, responses: [json(usage({ current_weekly_status: 3, current_weekly_remaining_percent: 100 }))] });
  const [account] = await minimax.fetch(context);
  assert.equal(account.windows[1].value, "unlimited");
  assert.equal(account.windows[1].used_percent, null);
});

test("MiniMax has no configuration without a key", async () => {
  await assert.rejects(minimax.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`MiniMax rejected credentials (${status}) ask to sign in after fallbacks`, async () => {
  const context = fakeContext({ env, responses: Array.from({ length: 4 }, () => json({}, status)) });
  assert.equal((await minimax.fetch(context))[0].error, "sign in");
});

test("MiniMax retries legacy then China after global authentication fails", async () => {
  const context = fakeContext({ env, responses: [json({}, 401), json({}, 401), json(usage())] });
  assert.equal((await minimax.fetch(context))[0].windows[0].used_percent, 75);
  assert.deepEqual(context.calls.map((call) => call.url), ["https://api.minimax.io/v1/token_plan/remains", "https://api.minimax.io/v1/api/openplatform/coding_plan/remains", "https://api.minimaxi.com/v1/token_plan/remains"]);
});

test("MiniMax falls back from a missing current endpoint to legacy", async () => {
  const context = fakeContext({ env, responses: [json({}, 404), json(usage())] });
  assert.equal((await minimax.fetch(context))[0].windows.length, 2);
});

test("MiniMax honors explicit China host without trying global", async () => {
  const context = fakeContext({ env: { ...env, MINIMAX_HOST: "platform.minimaxi.com" }, responses: [json(usage())] });
  await minimax.fetch(context);
  assert.equal(context.calls[0].url, "https://api.minimaxi.com/v1/token_plan/remains");
});

test("MiniMax handles structured authentication failures", async () => {
  const context = fakeContext({ env, responses: Array.from({ length: 4 }, () => json({ base_resp: { status_code: 1004 } })) });
  assert.equal((await minimax.fetch(context))[0].error, "sign in");
});

for (const retry of [undefined, "45"]) test(`MiniMax rate limits (${retry ?? "default"})`, async () => {
  const context = fakeContext({ env, responses: [json({}, 429, retry ? { "retry-after": retry } : {})] });
  await assert.rejects(minimax.fetch(context), (error: unknown) => error instanceof RateLimited && error.until === NOW + (retry ? 45 : 300));
});

for (const response of [json({}, 500), json({}), json([]), json({ model_remains: [{}] }), new Response("not json"), json({ base_resp: { status_code: 999 } })]) {
  test(`MiniMax rejects HTTP errors and malformed responses ${response.status}`, async () => {
    await assert.rejects(minimax.fetch(fakeContext({ env, responses: [response] })), HttpError);
  });
}

 test("MiniMax selects text quota ahead of media and never uses media weekly counts", async () => {
  const context = fakeContext({ env, responses: [json({ model_remains: [{ ...model, model_name: "image-01", current_interval_usage_count: 0 }, model] })] });
  assert.equal((await minimax.fetch(context))[0].windows[0].used_percent, 75);
  const media = fakeContext({ env, responses: [json({ model_remains: [{ ...model, model_name: "image-01" }] })] });
  assert.equal((await minimax.fetch(media))[0].windows.length, 1);
});

 test("MiniMax passes a timeout signal and propagates service errors after rejection", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return json(usage());
  };
  await minimax.fetch(context);
  await assert.rejects(minimax.fetch(fakeContext({ env, responses: [json({}, 401), json({}, 500)] })), HttpError);
});

for (const status of [302, 405]) test(`MiniMax falls back to legacy after HTTP ${status}`, async () => {
  const context = fakeContext({ env, responses: [json({}, status), json(usage())] });
  assert.equal((await minimax.fetch(context))[0].windows[0].used_percent, 75);
  assert.equal(context.calls[1].url, "https://api.minimax.io/v1/api/openplatform/coding_plan/remains");
});

for (const response of [new Response("not json"), json({ model_remains: [{}] })]) {
  test("MiniMax falls back to legacy after an unparseable current response", async () => {
    const context = fakeContext({ env, responses: [response, json(usage())] });
    assert.equal((await minimax.fetch(context))[0].windows[0].used_percent, 75);
    assert.equal(context.calls.length, 2);
  });
}

test("MiniMax retries a transport failure only against the legacy endpoint", async () => {
  const context = fakeContext({ env });
  let calls = 0;
  context.fetch = async (input) => {
    calls++;
    if (calls === 1) throw new TypeError("fake network failure");
    assert.equal(String(input), "https://api.minimax.io/v1/api/openplatform/coding_plan/remains");
    return json(usage());
  };
  assert.equal((await minimax.fetch(context))[0].windows.length, 2);
  assert.equal(calls, 2);
});

test("MiniMax propagates cancellation without legacy fallback", async () => {
  const context = fakeContext({ env });
  let calls = 0;
  const cancelled = new DOMException("cancelled", "AbortError");
  context.fetch = async () => { calls++; throw cancelled; };
  await assert.rejects(minimax.fetch(context), (error: unknown) => error === cancelled);
  assert.equal(calls, 1);
});

test("MiniMax sanitizes an exhausted transport fallback", async () => {
  const context = fakeContext({ env });
  let calls = 0;
  context.fetch = async () => { calls++; throw new TypeError("fake secret-bearing failure"); };
  await assert.rejects(minimax.fetch(context), (error: unknown) => error instanceof HttpError && !error.message.includes("secret"));
  assert.equal(calls, 2);
});

for (const status of [429, 500]) test(`MiniMax propagates legacy HTTP ${status} after parsing fallback`, async () => {
  const context = fakeContext({ env, responses: [json({}), json({}, status)] });
  await assert.rejects(minimax.fetch(context), status === 429 ? RateLimited : HttpError);
  assert.equal(context.calls.length, 2);
});

 test("MiniMax retries a timed out current endpoint and preserves exhausted timeout identity", async () => {
  const context = fakeContext({ env });
  let calls = 0;
  context.fetch = async () => {
    calls++;
    if (calls === 1) throw new DOMException("fake timeout", "TimeoutError");
    return json(usage());
  };
  assert.equal((await minimax.fetch(context))[0].windows.length, 2);
  assert.equal(calls, 2);
  context.fetch = async () => { throw new DOMException("fake secret timeout", "TimeoutError"); };
  await assert.rejects(minimax.fetch(context), (error: unknown) =>
    error instanceof DOMException && error.name === "TimeoutError" && !error.message.includes("secret"));
});

 test("MiniMax does not queue retries across polling calls after a flapping dependency", async () => {
  const context = fakeContext({ env, responses: [json({}, 405), json({}, 500), json(usage())] });
  await assert.rejects(minimax.fetch(context), HttpError);
  assert.equal((await minimax.fetch(context))[0].windows.length, 2);
  assert.equal(context.calls.length, 3);
});

for (const legacy of [false, true]) test(`MiniMax preserves body cancellation at ${legacy ? "legacy" : "current"} endpoint`, async () => {
  const cancelled = new DOMException("cancelled body", "AbortError");
  class CancelledBodyResponse extends Response {
    override readonly json = async (): Promise<unknown> => { throw cancelled; };
  }
  const response = new CancelledBodyResponse();
  const context = fakeContext({ env, responses: legacy ? [json({}, 405), response] : [response] });
  await assert.rejects(minimax.fetch(context), (error: unknown) => error === cancelled);
  assert.equal(context.calls.length, legacy ? 2 : 1);
});

test("MiniMax retries a timed out current body but preserves exhausted body timeout identity", async () => {
  function timedOutBody(): Response {
    class TimedOutBodyResponse extends Response {
      override readonly json = async (): Promise<unknown> => {
        throw new DOMException("fake secret body timeout", "TimeoutError");
      };
    }
    return new TimedOutBodyResponse();
  }
  const context = fakeContext({ env, responses: [timedOutBody(), json(usage())] });
  assert.equal((await minimax.fetch(context))[0].windows.length, 2);
  assert.equal(context.calls.length, 2);
  const exhausted = fakeContext({ env, responses: [timedOutBody(), timedOutBody()] });
  await assert.rejects(minimax.fetch(exhausted), (error: unknown) =>
    error instanceof DOMException && error.name === "TimeoutError" && !error.message.includes("secret"));
  assert.equal(exhausted.calls.length, 2);
});
