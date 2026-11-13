import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { manus } from "../src/providers/manus.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Based on ManusPluginTests sparse credits fixture, with a future daily reset.
const credits = { totalCredits: "1200", periodicCredits: "300", proMonthlyCredits: 1000,
  refreshCredits: "25", maxRefreshCredits: 100, nextRefreshTime: NOW + 86400 - 978307200,
  refreshInterval: "DAILY REFRESH" };
const env = { MANUS_SESSION_TOKEN: "fixture-token" };
const config = (entry: Record<string, unknown>) => ({
  "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { manus: entry } }),
});

test("Manus maps daily and monthly credits, with bearer auth", async () => {
  const context = fakeContext({ env, responses: [json(credits)] });
  const [account] = await manus.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.minutes, w.used_percent, w.resets_at]),
    [[1440, 75, NOW + 86400], [43200, 70, null]]);
  assert.equal(account.account, "default");
  assert.equal(context.calls[0].url, "https://api.manus.im/user.v1.UserService/GetAvailableCredits");
  assert.equal(context.calls[0].headers.authorization, "Bearer fixture-token");
  assert.equal(context.calls[0].headers["connect-protocol-version"], "1");
});

for (const envelope of ["data", "result", "response", "availableCredits"]) {
  test(`Manus accepts ${envelope} envelope and explicit zero balance`, async () => {
    const [account] = await manus.fetch(fakeContext({ env, responses: [json({ [envelope]: { totalCredits: 0 } })] }));
    assert.equal(account.windows[0].value, "0 cr");
  });
}

test("Manus missing credential and disabled cookies", async () => {
  await assert.rejects(manus.fetch(fakeContext({})), NotConfigured);
  await assert.rejects(manus.fetch(fakeContext({ env, files: config({ cookieSource: "off" }) })), NotConfigured);
});

for (const status of [401, 403]) {
  test(`Manus ${status} asks to sign in`, async () => {
    const [account] = await manus.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account.error, "sign in");
  });
}

test("Manus rate limit respects Retry-After", async () => {
  await assert.rejects(manus.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "45" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 45);
});

test("Manus browser rejection falls back to environment, but manual does not", async () => {
  const context = fakeContext({ env, files: config({ cookieHeader: "session_id=browser" }),
    responses: [json({}, 401), json(credits)] });
  await manus.fetch(context);
  assert.deepEqual(context.calls.map((call) => call.headers.authorization), ["Bearer browser", "Bearer fixture-token"]);
  const manual = fakeContext({ env, files: config({ cookieSource: "manual", cookieHeader: "session_id=manual" }),
    responses: [json({}, 403)] });
  assert.equal((await manus.fetch(manual))[0].error, "sign in");
  assert.equal(manual.calls.length, 1);
});

test("Manus handles lossy numbers, Foundation zero date and ISO date", async () => {
  const [old] = await manus.fetch(fakeContext({ env, responses: [json({ ...credits, refreshCredits: "bad", nextRefreshTime: 0 })] }));
  assert.equal(old.windows[0].resets_at, 978307200);
  assert.equal(old.windows[0].used_percent, 0);
  const [future] = await manus.fetch(fakeContext({ env, responses: [json({ ...credits,
    refreshCredits: "bad", nextRefreshTime: new Date((NOW + 200) * 1000).toISOString() })] }));
  assert.equal(future.windows[0].resets_at, NOW + 200);
  assert.equal(future.blocked, true);
});

for (const body of [{}, { error: "private" }, { nextRefreshTime: 0 }, null]) {
  test(`Manus rejects non-credit response ${JSON.stringify(body)}`, async () => {
    await assert.rejects(manus.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  });
}

test("Manus invalid JSON and server failure are sanitized", async () => {
  for (const response of [new Response("secret", { status: 200 }), json({ secret: "key" }, 500)]) {
    await assert.rejects(manus.fetch(fakeContext({ env, responses: [response] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("secret"));
  }
});

test("Manus cookie environment aliases and session token precedence", async () => {
  for (const key of ["manus_session_token", "MANUS_SESSION_ID", "manus_session_id", "MANUS_COOKIE", "manus_cookie"]) {
    const context = fakeContext({ env: { [key]: "Session_ID=fixture" }, responses: [json(credits)] });
    await manus.fetch(context);
    assert.equal(context.calls[0].headers.authorization, "Bearer fixture");
  }
  const context = fakeContext({ env: { ...env, MANUS_COOKIE: "session_id=second" }, responses: [json(credits)] });
  await manus.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer fixture-token");
});

test("Manus empty manual field never imports browser or uses env", async () => {
  const context = fakeContext({ env, files: config({ cookieSource: "manual", cookieHeader: "" }) });
  context.querySqlite = async () => { throw new Error("manual must not import"); };
  await assert.rejects(manus.fetch(context), NotConfigured);
});

test("Manus unknown refresh period retains explicit name without invented daily duration", async () => {
  const [account] = await manus.fetch(fakeContext({ env, responses: [json({ ...credits, refreshInterval: "weekly" })] }));
  assert.equal(account.windows[0].name, "refresh");
  assert.equal(account.windows[0].minutes, null);
});

test("Manus invalid token env still considers a valid cookie env", async () => {
  const context = fakeContext({ env: { MANUS_SESSION_TOKEN: "foo=bar", MANUS_COOKIE: "session_id=valid-fake" },
    responses: [json(credits)] });
  await manus.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer valid-fake");
});
