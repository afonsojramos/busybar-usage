import assert from "node:assert/strict";
import { test } from "node:test";
import { gitkraken } from "../src/providers/gitkraken.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
} from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic counters follow CodexBar's provider fixture; dates are moved beyond NOW.
const fixture = {
  data: {
    used: 12500,
    limit: 400000,
    resetsOn: "2030-09-27T00:00:00Z",
    organization: { used: 50000, limit: 100000 },
    sharedUsed: 4000,
  },
};
const configured = {
  env: { GITKRAKEN_API_TOKEN: "fake-key", GITKRAKEN_ORG_ID: "org-fixture" },
  files: {},
};
const responses = (body: unknown = fixture) => [json(body)];

test("gitkraken: maps the CodexBar contract and sends the expected credential", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const [account] = await gitkraken.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => w.name),
    ["Personal", "Pool"],
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    [3, 50],
  );
  assert.equal(
    context.calls[0].url,
    "https://api.gitkraken.dev/v1/ai-tasks/usage",
  );
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-key");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
});

test("gitkraken: missing credentials are not configured", async () => {
  await assert.rejects(gitkraken.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`gitkraken: HTTP ${status} requests sign-in`, async () => {
    const context = fakeContext({
      ...configured,
      responses: [json({}, status)],
    });
    const [account] = await gitkraken.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("gitkraken: rate limiting honors Retry-After", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(
    gitkraken.fetch(context),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 120,
  );
});

test("gitkraken: malformed payloads and HTTP errors are sanitized", async () => {
  for (const response of [
    json({}),
    new Response("secret-body"),
    json({}, 500),
  ]) {
    const context = fakeContext({ ...configured, responses: [response] });
    await assert.rejects(
      gitkraken.fetch(context),
      (e: unknown) =>
        e instanceof HttpError && !e.message.includes("secret-body"),
    );
  }
});

test("gitkraken: organization header, unlimited and absent organization data", async () => {
  const context = fakeContext({
    ...configured,
    responses: responses({
      data: {
        used: 1,
        limit: -1,
        resetsOn: "2030-09-27T00:00:00Z",
        organization: { used: "bad", limit: 1 },
      },
    }),
  });
  const [account] = await gitkraken.fetch(context);
  assert.equal(context.calls[0].headers["gk-org-id"], "org-fixture");
  assert.equal(context.calls[0].headers["client-name"], "CodexBar");
  assert.deepEqual(
    account.windows.map((w) => w.value),
    ["Unlimited"],
  );
  const [zero] = await gitkraken.fetch(
    fakeContext({
      ...configured,
      responses: responses({
        data: { used: 0, limit: 0, resetsOn: "2030-09-27T00:00:00Z" },
      }),
    }),
  );
  assert.equal(zero.blocked, true);
  for (const data of [
    { used: -1, limit: 5, resetsOn: "2030-09-27T00:00:00Z" },
    { used: 0, limit: -2, resetsOn: "2030-09-27T00:00:00Z" },
    { used: 1, limit: 5, resetsOn: "2030-09-27" },
  ])
    await assert.rejects(
      gitkraken.fetch(
        fakeContext({ ...configured, responses: responses({ data }) }),
      ),
      HttpError,
    );
});

test("gitkraken: every request has a timeout and rejects redirects", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  await gitkraken.fetch(context);
});

test("gitkraken: saved API key is resolved from companion config", async () => {
  const env = Object.fromEntries(
    Object.entries(configured.env).filter(([name]) => !/KEY|TOKEN/.test(name)),
  );
  const context = fakeContext({
    env,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { gitkraken: { apiKey: "saved-key" } },
      }),
    },
    responses: responses(),
  });
  await gitkraken.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer saved-key");
});
