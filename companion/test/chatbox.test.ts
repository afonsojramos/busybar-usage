import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { chatbox } from "../src/providers/chatbox.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic counters follow CodexBar's provider fixture; dates are moved beyond NOW.
const fixture = {
  data: {
    status: "active",
    unified_token_usage: 300,
    unified_token_limit: 1500,
    unified_token_usage_details: [
      { type: "plan", token_usage: 200, token_limit: 1000 },
      { type: "invitation_reward", token_usage: 100, token_limit: 500 },
    ],
    aggregated_reward_details: { token_usage: 100, token_limit: 500 },
    expansion_pack_usage: 50,
    expansion_pack_limit: 400,
    image_used_count: 3,
    image_total_quota: 20,
    token_next_refresh_time: "2026-12-01T00:00:00Z",
    token_expire_time: "2027-01-01T00:00:00Z",
  },
};
const configured = { env: { CHATBOX_LICENSE_KEY: "fake-key" }, files: {} };
const responses = (body: unknown = fixture) => [json(body)];

test("chatbox: maps the CodexBar contract and sends the expected credential", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const [account] = await chatbox.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => w.name),
    ["Plan", "Top-up"],
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    [20, 13],
  );
  assert.equal(context.calls[0].url, "https://api.chatboxai.app/api/license/detail/realtime");
  assert.equal(context.calls[0].headers["authorization"], "fake-key");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
});

test("chatbox: missing credentials are not configured", async () => {
  await assert.rejects(chatbox.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`chatbox: HTTP ${status} requests sign-in`, async () => {
    const context = fakeContext({
      ...configured,
      responses: [json({}, status)],
    });
    const [account] = await chatbox.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("chatbox: rate limiting honors Retry-After", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(chatbox.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 120);
});

test("chatbox: malformed payloads and HTTP errors are sanitized", async () => {
  for (const response of [json({}), new Response("secret-body"), json({}, 500)]) {
    const context = fakeContext({ ...configured, responses: [response] });
    await assert.rejects(
      chatbox.fetch(context),
      (e: unknown) => e instanceof HttpError && !e.message.includes("secret-body"),
    );
  }
});

test("chatbox: expired plan, combined totals, reward fallback and image-only pools", async () => {
  const inputs = [
    { data: { ...fixture.data, status: "expired" } },
    { data: { unified_token_usage: 20, unified_token_limit: 100 } },
    {
      data: {
        unified_token_usage_details: [
          {
            type: "reward",
            token_usage: 10,
            token_limit: 20,
            expires_at: "2030-01-01T00:00:00Z",
          },
          {
            type: "reward",
            token_usage: 50,
            token_limit: 100,
            expires_at: "2020-01-01T00:00:00Z",
          },
        ],
      },
    },
    { data: { image_used_count: 3, image_total_quota: 20 } },
    { data: { aggregated_reward_details: { token_usage: 0, token_limit: 0 } } },
  ];
  const expected = ["800 cr", "80 cr", "10 cr", "17", "0 / 0"];
  for (let i = 0; i < inputs.length; i++) {
    const [account] = await chatbox.fetch(fakeContext({ ...configured, responses: responses(inputs[i]) }));
    assert.equal(account.windows[0].value, expected[i]);
    assert.equal(account.windows[0].resets_at, null);
  }
});

test("chatbox: duplicate plans, invalid counters and error envelopes fail", async () => {
  for (const body of [
    { error: { message: "private" }, data: fixture.data },
    { data: { unified_token_usage: -1, unified_token_limit: 100 } },
    { data: { expansion_pack_usage: "5", expansion_pack_limit: 100 } },
    {
      data: {
        unified_token_usage_details: [
          { type: "plan", token_usage: 1, token_limit: 5 },
          { type: "plan", token_usage: 2, token_limit: 5 },
        ],
      },
    },
    { data: { unified_token_usage_details: "bad" } },
    { data: { aggregated_reward_details: [] } },
  ]) {
    await assert.rejects(chatbox.fetch(fakeContext({ ...configured, responses: responses(body) })), HttpError);
  }
});

test("chatbox: reset must precede expiration and exhausted plan blocks", async () => {
  const [account] = await chatbox.fetch(
    fakeContext({
      ...configured,
      responses: responses({
        data: {
          ...fixture.data,
          unified_token_usage_details: [{ type: "plan", token_usage: 1000, token_limit: 1000 }],
          token_next_refresh_time: "2028-01-01T00:00:00Z",
        },
      }),
    }),
  );
  assert.equal(account.windows[0].resets_at, null);
  assert.equal(account.blocked, true);
});

test("chatbox: every request has a timeout and rejects redirects", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  await chatbox.fetch(context);
});

test("chatbox: saved API key is resolved from companion config", async () => {
  const env = Object.fromEntries(Object.entries(configured.env).filter(([name]) => !/KEY|TOKEN/.test(name)));
  const context = fakeContext({
    env,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { chatbox: { apiKey: "saved-key" } },
      }),
    },
    responses: responses(),
  });
  await chatbox.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "saved-key");
});

test("chatbox: an exhausted count-only quota is blocked", async () => {
  const [account] = await chatbox.fetch(
    fakeContext({
      ...configured,
      responses: responses({
        data: { image_used_count: 20, image_total_quota: 20 },
      }),
    }),
  );
  assert.equal(account.windows[0].value, "0");
  assert.equal(account.blocked, true);
});
