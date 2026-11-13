import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { typesafe } from "../src/providers/typesafe.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const credentials = {
  files: {
    "/home/test/.config/busybar-usage/config.json": '{"providers": {"typesafe": {"cookieHeader": "session=fake"}}}',
  },
};
// Based on CodexBar's typesafe plugin fixtures, with reset times moved after the test clock.
const happy = () => [
  json({ billing: { plan: "free_plan", spent: 0.01, balance: 4.98, cycleLabel: "September 2026", credits: [] } }),
];

test("typesafe: CodexBar fixture", async () => {
  const ctx = fakeContext({ ...credentials, responses: happy() });
  const [account] = await typesafe.fetch(ctx);
  assert.equal(account.error, undefined);
  assert.deepEqual(
    account.windows.map((w) => w.value),
    ["$4.98", "$0.01"],
  );
});

test("typesafe: missing credentials", async () => {
  await assert.rejects(typesafe.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`typesafe: ${status} requires sign in`, async () => {
    const ctx = fakeContext({ ...credentials, responses: [json({ private: "must not leak" }, status)] });
    const [account] = await typesafe.fetch(ctx);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("typesafe: rate limit", async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({}, 429, { "retry-after": "17" })] });
  await assert.rejects(typesafe.fetch(ctx), (e: unknown) => e instanceof RateLimited && e.until === NOW + 17);
});

test("typesafe: invalid body is sanitized", async () => {
  const ctx = fakeContext({ ...credentials, responses: [new Response("private malformed body")] });
  await assert.rejects(typesafe.fetch(ctx), (e: unknown) => e instanceof HttpError && !e.message.includes("private"));
});

test("typesafe: HTML login and login redirect", async () => {
  for (const response of [
    new Response("<html>Sign in</html>"),
    new Response(null, { status: 302, headers: { location: "/login" } }),
  ]) {
    assert.equal((await typesafe.fetch(fakeContext({ ...credentials, responses: [response] })))[0].error, "sign in");
  }
});

test("typesafe: cookie source off prevents requests even with a saved header", async () => {
  const files = {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({
      providers: { typesafe: { cookieSource: "off", cookieHeader: "fake" } },
    }),
  };
  const ctx = fakeContext({ files });
  await assert.rejects(typesafe.fetch(ctx), NotConfigured);
  assert.equal(ctx.calls.length, 0);
});

test("typesafe: external login redirect is sign-in, benign route move is HTTP failure", async () => {
  const external = fakeContext({
    ...credentials,
    responses: [new Response(null, { status: 302, headers: { location: "https://identity.example.test/authorize" } })],
  });
  assert.equal((await typesafe.fetch(external))[0].error, "sign in");
  const benign = fakeContext({
    ...credentials,
    responses: [new Response(null, { status: 302, headers: { location: "/billing" } })],
  });
  await assert.rejects(typesafe.fetch(benign), HttpError);
});
