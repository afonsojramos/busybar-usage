import assert from "node:assert/strict";
import { test } from "node:test";
import { hyper } from "../src/providers/hyper.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const credentials = { "env": { "HYPER_API_KEY": "fake-key" } };
// Based on CodexBar's hyper plugin fixtures, with reset times moved after the test clock.
const happy = () => [json({ balance: 42.5 })];

test("hyper: CodexBar fixture", async () => {
  const ctx = fakeContext({ ...credentials, responses: happy() });
  const [account] = await hyper.fetch(ctx);
  assert.equal(account.error, undefined);
  assert.equal(account.windows[0].value, "42.5 HC");
});

test("hyper: missing credentials", async () => {
  await assert.rejects(hyper.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`hyper: ${status} requires sign in`, async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({ private: "must not leak" }, status)] });
  const [account] = await hyper.fetch(ctx);
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("hyper: rate limit", async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({}, 429, { "retry-after": "17" })] });
  await assert.rejects(hyper.fetch(ctx), (e: unknown) => e instanceof RateLimited && e.until === NOW + 17);
});

test("hyper: invalid body is sanitized", async () => {
  const ctx = fakeContext({ ...credentials, responses: [new Response("private malformed body")] });
  await assert.rejects(hyper.fetch(ctx), (e: unknown) => e instanceof HttpError && !e.message.includes("private"));
});

test("hyper: session dashboard and expired-session API fallback", async () => {
  const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { hyper: { cookieHeader: "session=fake" } } }) };
  const html = '<a href="/teams/11111111-2222-3333-4444-555555555555/dashboard">team</a>Hypercredits Available<p class="text-5xl font-bold">100</p>';
  const ctx = fakeContext({ ...credentials, files, responses: [new Response(html)] });
  assert.equal((await hyper.fetch(ctx))[0].windows[0].value, "100 HC");
  assert.equal(ctx.calls[0].headers.authorization, undefined);
  const expired = fakeContext({ ...credentials, files, responses: [json({}, 401), json({ balance: 12 })] });
  assert.equal((await hyper.fetch(expired))[0].windows[0].value, "12 HC");
  assert.equal(expired.calls[1].headers.cookie, undefined);
});

test("hyper: same-host dashboard redirect", async () => {
  const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { hyper: { cookieHeader: "session=fake" } } }) };
  const ctx = fakeContext({ files, responses: [new Response(null, { status: 302, headers: { location: "/teams/11111111-2222-3333-4444-555555555555/dashboard" } }), new Response('<a href="/teams/11111111-2222-3333-4444-555555555555/dashboard">team</a>Hypercredits Available<p class="text-5xl font-bold">42</p>')] });
  assert.equal((await hyper.fetch(ctx))[0].windows[0].value, "42 HC");
  assert.equal(ctx.calls.length, 2);
});

test("hyper: network refusal and timeout fall back, caller cancellation propagates", async () => {
  for (const error of [new TypeError("fetch failed"), new DOMException("timed out", "TimeoutError"), new DOMException("cancelled", "AbortError")]) {
    const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { hyper: { cookieHeader: "session=fake" } } }) };
    const ctx = fakeContext({ ...credentials, files, responses: [json({ balance: 12 })] });
    const fetch = ctx.fetch;
    let first = true;
    ctx.fetch = async (input, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      if (first) { first = false; throw error; }
      return fetch(input, init);
    };
    if (error.name === "AbortError") await assert.rejects(hyper.fetch(ctx), e => e === error);
    else assert.equal((await hyper.fetch(ctx))[0].windows[0].value, "12 HC");
  }
});
