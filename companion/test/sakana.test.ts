import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { sakana } from "../src/providers/sakana.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { SAKANA_COOKIE: "Cookie: session=fake-session" };
const usage = `<div data-slot="card"><p>5-hour</p><p>12.5% used</p><p>Resets on December 1, 2026 at 12:15 PM</p><p>Weekly</p><p>73% used</p><p>Resets on December 5, 2026 at 12:00 AM</p></div>`;

test("Sakana maps CodexBar billing markup and UTC resets", async () => {
  const context = fakeContext({ env, responses: [new Response(usage)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal);
    assert.equal(init?.redirect, "manual");
    return fetch(input, init);
  };
  const [account] = await sakana.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent, w.resets_at]),
    [
      ["5h", 13, Date.parse("2026-12-01T12:15:00Z") / 1000],
      ["7d", 73, Date.parse("2026-12-05T00:00:00Z") / 1000],
    ],
  );
  assert.equal(account.account, "default");
  assert.equal(context.calls[0].url, "https://console.sakana.ai/billing");
  assert.equal(context.calls[0].headers.cookie, "session=fake-session");
  assert.equal(context.calls[0].headers.accept, "text/html,application/xhtml+xml");
});

test("Sakana missing manual cookie is not configured", async () => {
  await assert.rejects(sakana.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403, 302]) {
  test(`Sakana ${status} asks to sign in`, async () => {
    const [account] = await sakana.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account.error, "sign in");
  });
}

test("Sakana honors Retry-After", async () => {
  await assert.rejects(
    sakana.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "20" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 20,
  );
});

test("Sakana uses PAYG as the second lane when only one quota is available", async () => {
  const context = fakeContext({
    env,
    responses: [
      new Response("<p>Weekly</p><p>25% used</p>"),
      new Response('<h2>Credit balance</h2><p class="tabular-nums">$1,234.50</p>'),
    ],
  });
  const [account] = await sakana.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent, w.value]),
    [
      ["7d", 25, undefined],
      ["Balance", null, "$1234.50"],
    ],
  );
  assert.equal(context.calls[1].url, "https://console.sakana.ai/billing?tab=payAsYouGo");
});

test("Sakana optional PAYG failure preserves quotas and invalid dates stay unknown", async () => {
  const [account] = await sakana.fetch(
    fakeContext({
      env,
      responses: [
        new Response("<p>5-hour</p><p>100% used</p><p>Resets on February 31, 2027 at 1:00 PM</p>"),
        json({}, 500),
      ],
    }),
  );
  assert.equal(account.windows[0].resets_at, null);
  assert.equal(account.blocked, true);
});

test("Sakana reads a manual saved cookie without requiring an environment variable", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { sakana: { cookieHeader: "session=fake-config" } },
      }),
    },
    responses: [new Response(usage)],
  });
  await sakana.fetch(context);
  assert.equal(context.calls[0].headers.cookie, "session=fake-config");
});

for (const body of [
  "",
  "<h1>Log in</h1>",
  "<p>5-hour</p><p>101% used</p>",
  "<p>5-hour</p><p>unknown</p><p>Weekly</p><p>50% used</p>",
]) {
  test("Sakana malformed quota markup fails visibly", async () => {
    await assert.rejects(sakana.fetch(fakeContext({ env, responses: [new Response(body)] })), HttpError);
  });
}
