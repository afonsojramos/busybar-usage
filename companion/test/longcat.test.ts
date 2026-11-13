import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { longcat } from "../src/providers/longcat.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const env = { LONGCAT_MANUAL_COOKIE: "passport_token=fake; uid=42" };
const account = { code: 0, data: { name: "Fixture", email: "user@example.com" } };
const lot = { code: 0, data: { currentLot: { status: "ACTIVE", totalToken: "1000000", consumedToken: "250000" } } };
const fuel = { code: 0, data: { totalQuota: 1000, list: [{ availableToken: 400, expireTime: (NOW + 3600) * 1000 }, { availableToken: 100, expireTime: new Date((NOW + 7200) * 1000).toISOString() }] } };
test("LongCat matches CodexBar active lot and fuel quota schema", async () => {
  const c = fakeContext({ env, responses: [json(account), json(lot), json(fuel)] });
  const [a] = await longcat.fetch(c);
  assert.equal(a?.account, "example");
  assert.deepEqual(a?.windows.map((w) => [w.name, w.used_percent, w.resets_at]), [["Tokens", 25, null], ["Fuel", 50, NOW + 3600]]);
  assert.equal(c.calls[0]?.url, "https://longcat.chat/api/v1/user-current");
  assert.equal(c.calls[1]?.url, "https://longcat.chat/api/pay/quota/metering/token-packs/summary");
  assert.equal(c.calls[0]?.headers.cookie, env.LONGCAT_MANUAL_COOKIE);
});
test("LongCat needs cookies", async () => { await assert.rejects(longcat.fetch(fakeContext({})), NotConfigured); });
for (const status of [401, 403]) test(`LongCat ${status} needs sign in`, async () => {
  assert.equal((await longcat.fetch(fakeContext({ env, responses: [json({}, status)] })))[0]?.error, "sign in");
});
test("LongCat rate limits respect retry-after", async () => {
  await assert.rejects(longcat.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "11" })] })), (e: unknown) => e instanceof RateLimited && e.until === NOW + 11);
});
test("LongCat supports fallback aggregate with available tokens and optional probe failures", async () => {
  const c = fakeContext({ env, responses: [json(account), json({}, 404), json({ data: { usage: { totalToken: "100", availableToken: "20" } } }), json({}, 500)] });
  assert.deepEqual((await longcat.fetch(c))[0]?.windows.map((w) => w.used_percent), [80]);
  assert.match(c.calls[2]?.url ?? "", /tokenUsage$/);
});
test("LongCat rejects broken envelopes without leaking response bodies", async () => {
  for (const response of [json({ code: "NaN" }), json({ code: 999, message: "fake-secret" }), new Response("fake-secret"), json({}, 500)]) {
    await assert.rejects(longcat.fetch(fakeContext({ env, responses: [response] })), (e: unknown) => e instanceof HttpError && !e.message.includes("fake-secret"));
  }
  assert.equal((await longcat.fetch(fakeContext({ env, responses: [json({ code: 401 })] })))[0]?.error, "sign in");
});
test("LongCat handles lowercase cookie env and captured cookie header", async () => {
  const c = fakeContext({ env: { longcat_manual_cookie: "curl 'https://longcat.chat/' -H 'Cookie: session=fake'" }, responses: [json(account), json(lot), json({ data: {} })] });
  await longcat.fetch(c); assert.equal(c.calls[0]?.headers.cookie, "session=fake");
});
test("LongCat detects exhausted quota", async () => {
  const c = fakeContext({ env, responses: [json(account), json({ data: { currentLot: { status: "ACTIVE", totalToken: 100, consumedToken: 100 } } }), json({ data: {} })] });
  assert.equal((await longcat.fetch(c))[0]?.blocked, true);
});
test("LongCat independently omits nonfinite primary and fuel counts", async () => {
  const c = fakeContext({ env, responses: [json(account), json({ data: {} }), json({ data: { totalToken: "NaN" } }), json(fuel)] });
  assert.deepEqual((await longcat.fetch(c))[0]?.windows.map((w) => w.name), ["Fuel"]);
});


test("LongCat bounds finite counters whose percentages overflow", async () => {
  const c = fakeContext({ env, responses: [json(account), json({ data: { currentLot: {
    status: "ACTIVE", totalToken: 1, consumedToken: 1e308,
  } } }), json({ data: { totalQuota: 1, list: [{ availableToken: -1e308 }] } })] });
  const [a] = await longcat.fetch(c);
  assert.deepEqual(a.windows.map((w) => w.used_percent), [100, 100]);
  assert.equal(a.blocked, true);
});

test("LongCat independently omits fuel when counter subtraction overflows", async () => {
  const c = fakeContext({ env, responses: [json(account), json(lot),
    json({ data: { totalQuota: 1e308, list: [{ availableToken: -1e308 }] } }),
  ] });
  const [a] = await longcat.fetch(c);
  assert.deepEqual(a.windows.map((w) => w.name), ["Tokens"]);
});
