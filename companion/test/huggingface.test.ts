import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { huggingface } from "../src/providers/huggingface.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { HF_TOKEN: "fake-token" };
const fixture = [
  {
    usage: {
      inferenceProviders: { usedNanoUsd: 2450000000, includedNanoUsd: 2000000000, limitNanoUsd: 0, numRequests: 128 },
    },
  },
  { base: 1500, current: 900, resetsAt: "2027-08-31T18:00:00Z" },
  { type: "user", id: "opaque-a", email: "dev@example.com" },
];

test("huggingface: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map((body) => json(body)) });
  const [account] = await huggingface.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "huggingface");
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [40, null],
  );
  assert.deepEqual(
    account.windows.map((w) => w.value ?? null),
    [null, "$0.45"],
  );
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://huggingface.co/api/settings/billing/usage-v2"));
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-token");
});

test("huggingface: missing credential", async () => {
  await assert.rejects(huggingface.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`huggingface: ${status} requires sign in`, async () => {
    const [account] = await huggingface.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account?.error, "sign in");
    assert.deepEqual(account?.windows, []);
  });

test("huggingface: rate limit preserves Retry-After", async () => {
  await assert.rejects(
    huggingface.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    (error) => error instanceof RateLimited && error.until === NOW + 42,
  );
  await assert.rejects(
    huggingface.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    (error) => error instanceof RateLimited && error.until === NOW + 300,
  );
});

test("huggingface: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(
      huggingface.fetch(fakeContext({ env, responses: [response] })),
      (error) => error instanceof HttpError && !error.message.includes("fake-private-body"),
    );
  }
});

test("huggingface: CLI token paths and optional endpoints preserve billing", async () => {
  for (const [env, path] of [
    [{}, "/home/test/.cache/huggingface/token"],
    [{ HF_TOKEN_PATH: "~/custom" }, "/home/test/custom"],
    [{ HF_HOME: "/hf" }, "/hf/token"],
    [{ XDG_CACHE_HOME: "/cache" }, "/cache/huggingface/token"],
  ] as const) {
    const context = fakeContext({
      env,
      files: { [path]: "fake-file-token\n" },
      responses: [json(fixture[0]), json({}, 503), json({}, 503)],
    });
    const [a] = await huggingface.fetch(context);
    assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-file-token");
    assert.equal(a?.windows[0]?.value, "$0.45");
  }
});

function walletPage(props: unknown): Response {
  return new Response(
    `<div data-props="${JSON.stringify(props).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div>`,
    { headers: { "content-type": "text/html" } },
  );
}

test("huggingface: wallet requires matching opaque user IDs and never gets bearer", async () => {
  for (const [props, expected] of [
    [{ entity: { type: "user", currentBalanceUsd: 12.4 } }, "$12.40"],
    [{ invoiceCreditsCents: 125 }, "$1.25"],
    [{ entity: { type: "user", currentBalanceUsd: 0 }, invoiceCreditsCents: 100 }, "$0.00"],
  ] as const) {
    const context = fakeContext({
      env,
      files: {
        "/home/test/.config/busybar-usage/config.json": JSON.stringify({
          providers: { huggingface: { cookieHeader: "session=fake" } },
        }),
      },
      responses: [
        json(fixture[0]),
        json({}, 503),
        json(fixture[2]),
        walletPage(props),
        json({ type: "user", id: "opaque-a" }),
      ],
    });
    const [a] = await huggingface.fetch(context);
    assert.equal(a?.windows[1]?.value, expected);
    assert.ok(context.calls.slice(3).every((c) => !c.headers.authorization && c.headers.cookie === "session=fake"));
  }
});

test("huggingface: mismatched and malformed wallets are omitted", async () => {
  for (const [props, identity] of [
    [{ entity: { type: "user", currentBalanceUsd: 12 } }, { type: "user", id: "other" }],
    [{ entity: { type: "user", currentBalanceUsd: "12" } }, { type: "user", id: "opaque-a" }],
  ]) {
    const context = fakeContext({
      env,
      files: {
        "/home/test/.config/busybar-usage/config.json": JSON.stringify({
          providers: { huggingface: { cookieHeader: "session=fake" } },
        }),
      },
      responses: [json(fixture[0]), json({}, 503), json(fixture[2]), walletPage(props), json(identity)],
    });
    const [a] = await huggingface.fetch(context);
    assert.equal(a?.windows.length, 1);
    assert.equal(a?.windows[0]?.value, "$0.45");
  }
});

test("huggingface: identity cache is token-scoped and browser wallet is always reverified", async () => {
  const context = fakeContext({
    env: { ...env },
    responses: [
      json(fixture[0]),
      json({}, 503),
      json(fixture[2]),
      json(fixture[0]),
      json({}, 503),
      json(fixture[0]),
      json({}, 503),
      json(fixture[2]),
    ],
  });
  await huggingface.fetch(context);
  await huggingface.fetch(context);
  assert.equal(context.calls.filter((c) => c.url.endsWith("whoami-v2")).length, 1);
  context.env.HF_TOKEN = "fake-other-token";
  await huggingface.fetch(context);
  assert.equal(context.calls.filter((c) => c.url.endsWith("whoami-v2")).length, 2);
});

test("huggingface: config key and request safety", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { huggingface: { apiKey: "fake-config", workspaceID: "team-1234" } },
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
  await huggingface.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-config");
});
