import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { flora } from "../src/providers/flora.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
} from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic counters follow CodexBar's provider fixture; dates are moved beyond NOW.
const fixture = {
  available_cost: 128.4,
  currency: "USD",
  balance_scope: "workspace",
  spend: { status: "available", total_cost: 12.5, classified_runs: 1234 },
};
const configured = {
  env: { FLORA_API_KEY: "fake-key", FLORA_WORKSPACE_ID: "ws_fixture123" },
  files: {},
};
const responses = (body: unknown = fixture) => [json(body)];

test("flora: maps the CodexBar contract and sends the expected credential", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const [account] = await flora.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => w.name),
    ["Balance", "Spent"],
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    ["$128.40", "$12.50"],
  );
  assert.equal(
    context.calls[0].url,
    "https://app.flora.ai/api/v1/workspaces/ws_fixture123/usage?start_date=2026-11-01&end_date=2026-11-13",
  );
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-key");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
});

test("flora: missing credentials are not configured", async () => {
  await assert.rejects(flora.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`flora: HTTP ${status} requests sign-in`, async () => {
    const context = fakeContext({
      ...configured,
      responses: [json({}, status)],
    });
    const [account] = await flora.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("flora: rate limiting honors Retry-After", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(
    flora.fetch(context),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 120,
  );
});

test("flora: malformed payloads and HTTP errors are sanitized", async () => {
  for (const response of [
    json({}),
    new Response("secret-body"),
    json({}, 500),
  ]) {
    const context = fakeContext({ ...configured, responses: [response] });
    await assert.rejects(
      flora.fetch(context),
      (e: unknown) =>
        e instanceof HttpError && !e.message.includes("secret-body"),
    );
  }
});

test("flora: caller scope and unavailable spend do not invent an allowance", async () => {
  const [account] = await flora.fetch(
    fakeContext({
      ...configured,
      responses: responses({
        balance_scope: "caller",
        available_cost: 0,
        member_limit: { limit_cost: 50, period: "month" },
        spend: { status: "unavailable", reason: "permission_missing" },
      }),
    }),
  );
  assert.equal(account.blocked, true);
  assert.deepEqual(
    account.windows.map((w) => w.value),
    ["$0.00"],
  );
  await assert.rejects(
    flora.fetch(
      fakeContext({
        ...configured,
        responses: responses({
          available_cost: 5,
          spend: { status: "available" },
        }),
      }),
    ),
    HttpError,
  );
});

test("flora: workspace is required and encoded path input is rejected", async () => {
  for (const workspace of ["", "ws_../secret", "ws_bad/path"])
    await assert.rejects(
      flora.fetch(
        fakeContext({
          env: { FLORA_API_KEY: "fake", FLORA_WORKSPACE_ID: workspace },
        }),
      ),
      NotConfigured,
    );
});

test("flora: every request has a timeout and rejects redirects", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  await flora.fetch(context);
});

test("flora: saved API key is resolved from companion config", async () => {
  const env = Object.fromEntries(
    Object.entries(configured.env).filter(([name]) => !/KEY|TOKEN/.test(name)),
  );
  const context = fakeContext({
    env,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { flora: { apiKey: "saved-key" } },
      }),
    },
    responses: responses(),
  });
  await flora.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer saved-key");
});

test("flora: large amounts in other currencies fit the display", async () => {
  const [account] = await flora.fetch(
    fakeContext({
      ...configured,
      responses: responses({
        currency: "EUR",
        available_cost: 1e308,
        spend: { status: "available", total_cost: 9999999 },
      }),
    }),
  );
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});
