import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { xkiro } from "../src/providers/xkiro.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { XKIRO_API_KEY: "fake-key" };
const fixture = [
  {
    object: "usage",
    user: { email: "dev@example.com" },
    plan: null,
    free_tokens: { used_today: 124035, limit_per_day: 5000000, remaining: 4875965 },
    wallet: { balance_usd: "4.812300" },
  },
];

test("xkiro: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map((body) => json(body)) });
  const [account] = await xkiro.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "xkiro");
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [2],
  );
  assert.deepEqual(
    account.windows.map((w) => w.value ?? null),
    [null],
  );
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://api.xkiro.com/v1/usage"));
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-key");
});

test("xkiro: missing credential", async () => {
  await assert.rejects(xkiro.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`xkiro: ${status} requires sign in`, async () => {
    const [account] = await xkiro.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account?.error, "sign in");
    assert.deepEqual(account?.windows, []);
  });

test("xkiro: rate limit preserves Retry-After", async () => {
  await assert.rejects(
    xkiro.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    (error) => error instanceof RateLimited && error.until === NOW + 42,
  );
  await assert.rejects(
    xkiro.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    (error) => error instanceof RateLimited && error.until === NOW + 300,
  );
});

test("xkiro: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(
      xkiro.fetch(fakeContext({ env, responses: [response] })),
      (error) => error instanceof HttpError && !error.message.includes("fake-private-body"),
    );
  }
});

test("xkiro: unknown headroom, zero limit, and malformed counters", async () => {
  const [unknown] = await xkiro.fetch(
    fakeContext({ env, responses: [json({ object: "usage", free_tokens: { limit_per_day: null, used_today: 0 } })] }),
  );
  assert.deepEqual(unknown?.windows, []);
  const [zero] = await xkiro.fetch(
    fakeContext({ env, responses: [json({ object: "usage", free_tokens: { limit_per_day: 0, used_today: 0 } })] }),
  );
  assert.equal(zero?.blocked, true);
  assert.equal(zero?.windows[0]?.resets_at, (Math.floor(NOW / 86400) + 1) * 86400);
  const [remaining] = await xkiro.fetch(
    fakeContext({ env, responses: [json({ object: "usage", free_tokens: { remaining: 12 } })] }),
  );
  assert.equal(remaining?.windows[0]?.value, "12");
  for (const value of ["12", -1, 1.2])
    await assert.rejects(
      xkiro.fetch(
        fakeContext({
          env,
          responses: [json({ object: "usage", free_tokens: { used_today: value, limit_per_day: 10 } })],
        }),
      ),
      HttpError,
    );
});

test("xkiro: config key and request safety", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { xkiro: { apiKey: "fake-config", workspaceID: "team-1234" } },
      }),
    },
    responses: fixture.map((b) => json(b)),
  });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.redirect, "error");
    return fetch(input, init);
  };
  await xkiro.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-config");
});
