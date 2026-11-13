import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { abliteration } from "../src/providers/abliteration.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic counters follow CodexBar's provider fixture; dates are moved beyond NOW.
const fixture = { data: { total_credits: 50, total_usage: 0.010637 } };
const configured = { env: { ABLITERATION_API_KEY: "fake-key" }, files: {} };
const responses = (body: unknown = fixture) => [json(body)];

test("abliteration: maps the CodexBar contract and sends the expected credential", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const [account] = await abliteration.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => w.name),
    ["Credits", "Balance"],
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    [0, "$49.99"],
  );
  assert.equal(context.calls[0].url, "https://api.abliteration.ai/v1/credits");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-key");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
});

test("abliteration: missing credentials are not configured", async () => {
  await assert.rejects(abliteration.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`abliteration: HTTP ${status} requests sign-in`, async () => {
    const context = fakeContext({
      ...configured,
      responses: [json({}, status)],
    });
    const [account] = await abliteration.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("abliteration: rate limiting honors Retry-After", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(abliteration.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 120);
});

test("abliteration: malformed payloads and HTTP errors are sanitized", async () => {
  for (const response of [json({}), new Response("secret-body"), json({}, 500)]) {
    const context = fakeContext({ ...configured, responses: [response] });
    await assert.rejects(
      abliteration.fetch(context),
      (e: unknown) => e instanceof HttpError && !e.message.includes("secret-body"),
    );
  }
});

test("abliteration: zero credits keep amounts and overspending blocks", async () => {
  for (const [total, used] of [
    [0, 0],
    [5, 8],
  ]) {
    const [account] = await abliteration.fetch(
      fakeContext({
        ...configured,
        responses: responses({
          data: { total_credits: total, total_usage: used },
        }),
      }),
    );
    assert.equal(account.blocked, true);
    assert.equal(account.windows.length, 2);
    assert.equal(account.windows[total > 0 ? 1 : 0].value, "$0.00");
  }
  for (const total of [-1, "5", null])
    await assert.rejects(
      abliteration.fetch(
        fakeContext({
          ...configured,
          responses: responses({
            data: { total_credits: total, total_usage: 0 },
          }),
        }),
      ),
      HttpError,
    );
});

test("abliteration: every request has a timeout and rejects redirects", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  await abliteration.fetch(context);
});

test("abliteration: saved API key is resolved from companion config", async () => {
  const env = Object.fromEntries(Object.entries(configured.env).filter(([name]) => !/KEY|TOKEN/.test(name)));
  const context = fakeContext({
    env,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { abliteration: { apiKey: "saved-key" } },
      }),
    },
    responses: responses(),
  });
  await abliteration.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer saved-key");
});
