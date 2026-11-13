import assert from "node:assert/strict";
import { test } from "node:test";
import { munito } from "../src/providers/munito.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
} from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic counters follow CodexBar's provider fixture; dates are moved beyond NOW.
const fixture = {
  periods: [
    {
      period: "day",
      spent_usd: 4.25,
      limit_usd: 50,
      organization_limit_usd: 500,
      account_limit_usd: 40,
    },
    { period: "month", spent_usd: 123.4, limit_usd: 1000 },
  ],
};
const configured = { env: { MUNITO_API_KEY: "fake-key" }, files: {} };
const responses = (body: unknown = fixture) => [
  json(body),
  json({ name: "Fixture org" }),
];

test("munito: maps the CodexBar contract and sends the expected credential", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const [account] = await munito.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => w.name),
    ["1d", "30d"],
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    [9, 12],
  );
  assert.equal(context.calls[0].url, "https://api.munito.ai/admin/v1/limits");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-key");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
});

test("munito: missing credentials are not configured", async () => {
  await assert.rejects(munito.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`munito: HTTP ${status} requests sign-in`, async () => {
    const context = fakeContext({
      ...configured,
      responses: [json({}, status)],
    });
    const [account] = await munito.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("munito: rate limiting honors Retry-After", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(
    munito.fetch(context),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 120,
  );
});

test("munito: malformed payloads and HTTP errors are sanitized", async () => {
  for (const response of [
    json({}),
    new Response("secret-body"),
    json({}, 500),
  ]) {
    const context = fakeContext({ ...configured, responses: [response] });
    await assert.rejects(
      munito.fetch(context),
      (e: unknown) =>
        e instanceof HttpError && !e.message.includes("secret-body"),
    );
  }
});

test("munito: no-limit spend, unknown periods and stopped spending", async () => {
  const [account] = await munito.fetch(
    fakeContext({
      ...configured,
      responses: responses({
        periods: [
          { period: "quarter", spent_usd: "ignored" },
          { period: "month", spent_usd: "12.75", limit_usd: 0 },
          {
            period: "day",
            spent_usd: "2",
            limit_usd: null,
            stopped_until: "2030-01-01T00:00:00Z",
          },
        ],
      }),
    }),
  );
  assert.equal(account.blocked, true);
  assert.deepEqual(
    account.windows.map((w) => w.value),
    ["$2.00", "$12.75"],
  );
  const [empty] = await munito.fetch(
    fakeContext({ ...configured, responses: responses({ periods: [] }) }),
  );
  assert.deepEqual(empty.windows, []);
  for (const period of [
    { period: "day", spent_usd: -1 },
    { period: "day", spent_usd: 1, limit_usd: "NaN" },
    { period: "day", spent_usd: 1, stopped_until: "tomorrow" },
  ]) {
    await assert.rejects(
      munito.fetch(
        fakeContext({
          ...configured,
          responses: responses({ periods: [period] }),
        }),
      ),
      HttpError,
    );
  }
});

test("munito: alias key and config key use the shared resolver", async () => {
  for (const config of [
    { env: { MUNITO_ADMIN_KEY: "alias" } },
    {
      files: {
        "/home/test/.config/busybar-usage/config.json": JSON.stringify({
          providers: { munito: { apiKey: "saved" } },
        }),
      },
    },
  ]) {
    const context = fakeContext({ ...config, responses: responses() });
    await munito.fetch(context);
    assert.match(
      context.calls[0].headers.authorization,
      /Bearer (alias|saved)/,
    );
  }
});

test("munito: every request has a timeout and rejects redirects", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  await munito.fetch(context);
});

test("munito: optional enrichment tolerates refused and timed-out requests but preserves cancellation", async () => {
  for (const error of [
    new TypeError("refused"),
    new DOMException("timed out", "TimeoutError"),
    new DOMException("cancelled", "AbortError"),
  ]) {
    const context = fakeContext({ ...configured, responses: [json(fixture)] });
    const fetch = context.fetch;
    let requests = 0;
    context.fetch = async (input, init) => {
      if (++requests === 2) throw error;
      return fetch(input, init);
    };
    if (error.name === "AbortError")
      await assert.rejects(munito.fetch(context), (e) => e === error);
    else assert.equal((await munito.fetch(context))[0].error, undefined);
  }
});

test("munito: saved API key is resolved from companion config", async () => {
  const env = Object.fromEntries(
    Object.entries(configured.env).filter(([name]) => !/KEY|TOKEN/.test(name)),
  );
  const context = fakeContext({
    env,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { munito: { apiKey: "saved-key" } },
      }),
    },
    responses: responses(),
  });
  await munito.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer saved-key");
});
