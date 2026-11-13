import assert from "node:assert/strict";
import { test } from "node:test";
import { tripo } from "../src/providers/tripo.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
} from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic counters follow CodexBar's provider fixture; dates are moved beyond NOW.
const fixture = { code: 0, data: { balance: 1200, frozen: 30 } };
const configured = { env: { TRIPO_API_KEY: "fake-key" }, files: {} };
const responses = (body: unknown = fixture) => [json(body)];

test("tripo: maps the CodexBar contract and sends the expected credential", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const [account] = await tripo.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => w.name),
    ["Balance", "Reserved"],
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    ["1.2K cr", "30 cr"],
  );
  assert.equal(
    context.calls[0].url,
    "https://openapi.tripo3d.ai/v3/account/balance",
  );
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-key");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
});

test("tripo: missing credentials are not configured", async () => {
  await assert.rejects(tripo.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`tripo: HTTP ${status} requests sign-in`, async () => {
    const context = fakeContext({
      ...configured,
      responses: [json({}, status)],
    });
    const [account] = await tripo.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("tripo: rate limiting honors Retry-After", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(
    tripo.fetch(context),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 120,
  );
});

test("tripo: malformed payloads and HTTP errors are sanitized", async () => {
  for (const response of [
    json({}),
    new Response("secret-body"),
    json({}, 500),
  ]) {
    const context = fakeContext({ ...configured, responses: [response] });
    await assert.rejects(
      tripo.fetch(context),
      (e: unknown) =>
        e instanceof HttpError && !e.message.includes("secret-body"),
    );
  }
});

test("tripo: reserved credits are not subtracted twice and invalid counters fail", async () => {
  const [account] = await tripo.fetch(
    fakeContext({
      ...configured,
      responses: responses({ code: 0, data: { balance: 5, frozen: 10 } }),
    }),
  );
  assert.equal(account.windows[0].value, "5 cr");
  for (const body of [
    { code: 1, data: { balance: 1, frozen: 0 } },
    { code: 0, data: { balance: -1, frozen: 0 } },
    { code: 0, data: { balance: "5", frozen: 0 } },
    { code: 0, data: { balance: 5 } },
  ]) {
    await assert.rejects(
      tripo.fetch(fakeContext({ ...configured, responses: responses(body) })),
      HttpError,
    );
  }
});

test("tripo: every request has a timeout and rejects redirects", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  await tripo.fetch(context);
});

test("tripo: saved API key is resolved from companion config", async () => {
  const env = Object.fromEntries(
    Object.entries(configured.env).filter(([name]) => !/KEY|TOKEN/.test(name)),
  );
  const context = fakeContext({
    env,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { tripo: { apiKey: "saved-key" } },
      }),
    },
    responses: responses(),
  });
  await tripo.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer saved-key");
});

test("tripo: extreme finite balances fit the display", async () => {
  const [account] = await tripo.fetch(
    fakeContext({
      ...configured,
      responses: responses({
        code: 0,
        data: { balance: 1e308, frozen: 1e308 },
      }),
    }),
  );
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});
