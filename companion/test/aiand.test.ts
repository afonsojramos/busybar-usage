import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { aiand } from "../src/providers/aiand.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { AIAND_API_KEY: "fake-key" };
const fixture = [
  {
    data: [
      { cost: "0.10", currency: "USD" },
      { cost: "0.20", currency: "USD" },
    ],
    has_more: false,
  },
];

test("aiand: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map((body) => json(body)) });
  const [account] = await aiand.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "aiand");
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [null],
  );
  assert.deepEqual(
    account.windows.map((w) => w.value ?? null),
    ["$0.30"],
  );
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://api.aiand.com/logs?range=30days&limit=100"));
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-key");
});

test("aiand: missing credential", async () => {
  await assert.rejects(aiand.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`aiand: ${status} requires sign in`, async () => {
    const [account] = await aiand.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account?.error, "sign in");
    assert.deepEqual(account?.windows, []);
  });

test("aiand: rate limit preserves Retry-After", async () => {
  await assert.rejects(
    aiand.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    (error) => error instanceof RateLimited && error.until === NOW + 42,
  );
  await assert.rejects(
    aiand.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    (error) => error instanceof RateLimited && error.until === NOW + 300,
  );
});

test("aiand: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(
      aiand.fetch(fakeContext({ env, responses: [response] })),
      (error) => error instanceof HttpError && !error.message.includes("fake-private-body"),
    );
  }
});

test("aiand: exact decimal sum, paired cursors and mixed currencies", async () => {
  const context = fakeContext({
    env,
    responses: [
      json({ data: [{ cost: "0.1", currency: "USD" }], has_more: true, next_after: "a b", next_after_id: "i/1" }),
      json({
        data: [
          { cost: "0.2", currency: "USD" },
          { cost: "100", currency: "JPY" },
        ],
        has_more: false,
      }),
    ],
  });
  const [a] = await aiand.fetch(context);
  assert.equal(a?.windows[0]?.value, "$0.30");
  assert.ok(context.calls[1]?.url.endsWith("&after=a%20b&after_id=i%2F1"));
});

test("aiand: partial pages are labeled and empty history has no invented currency", async () => {
  const [partial] = await aiand.fetch(
    fakeContext({ env, responses: [json({ data: [{ cost: "12", currency: "JPY" }], has_more: true })] }),
  );
  assert.equal(partial?.windows[0]?.name, "30d part");
  const [empty] = await aiand.fetch(fakeContext({ env, responses: [json({ data: [], has_more: false })] }));
  assert.deepEqual(empty?.windows, []);
  const context = fakeContext({
    env,
    responses: Array.from({ length: 10 }, () =>
      json({ data: [{ cost: "1", currency: "USD" }], has_more: true, next_after: "a", next_after_id: "b" }),
    ),
  });
  const [capped] = await aiand.fetch(context);
  assert.equal(context.calls.length, 10);
  assert.equal(capped?.windows[0]?.name, "30d part");
});

test("aiand: config key and request safety", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { aiand: { apiKey: "fake-config", workspaceID: "team-1234" } },
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
  await aiand.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-config");
});
