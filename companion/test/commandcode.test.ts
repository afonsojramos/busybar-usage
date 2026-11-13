import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { commandcode } from "../src/providers/commandcode.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
} from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic counters follow CodexBar's provider fixture; dates are moved beyond NOW.
const fixture = {
  credits: { monthlyCredits: 8.5, purchasedCredits: 5 },
  windowLimits: {
    fiveHour: { used: 2, cap: 10, resetAt: "2030-01-01T00:00:00Z" },
    weekly: { used: 3, cap: 20, resetAt: "2030-01-02T00:00:00Z" },
  },
};
const configured = { env: { COMMAND_CODE_API_KEY: "fake-key" }, files: {} };
const responses = (body: unknown = fixture) => [
  json(body),
  json({ success: true, data: null }),
];

test("commandcode: maps the CodexBar contract and sends the expected credential", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const [account] = await commandcode.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => w.name),
    ["5h", "7d"],
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    [20, 15],
  );
  assert.equal(
    context.calls[0].url,
    "https://api.commandcode.ai/alpha/billing/credits",
  );
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-key");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
});

test("commandcode: missing credentials are not configured", async () => {
  await assert.rejects(commandcode.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`commandcode: HTTP ${status} requests sign-in`, async () => {
    const context = fakeContext({
      ...configured,
      responses: [json({}, status)],
    });
    const [account] = await commandcode.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("commandcode: rate limiting honors Retry-After", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(
    commandcode.fetch(context),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 120,
  );
});

test("commandcode: malformed payloads and HTTP errors are sanitized", async () => {
  for (const response of [
    json({}),
    new Response("secret-body"),
    json({}, 500),
  ]) {
    const context = fakeContext({ ...configured, responses: [response] });
    await assert.rejects(
      commandcode.fetch(context),
      (e: unknown) =>
        e instanceof HttpError && !e.message.includes("secret-body"),
    );
  }
});

test("commandcode: cookie route and subscription plan fallback", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { commandcode: { cookieHeader: "Cookie: fake-session" } },
      }),
    },
    responses: [
      json({ credits: { monthlyCredits: 2, purchasedCredits: 5 } }),
      json({
        success: true,
        data: {
          planId: "individual-go-v1",
          currentPeriodEnd: "2030-01-01T00:00:00Z",
        },
      }),
    ],
  });
  const [account] = await commandcode.fetch(context);
  assert.equal(
    context.calls[0].url,
    "https://api.commandcode.ai/internal/billing/credits",
  );
  assert.equal(
    context.calls[0].headers.cookie,
    "__Secure-commandcode_prod_.session_token=fake-session",
  );
  assert.equal(context.calls[0].headers.origin, "https://commandcode.ai");
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    [80, "$5.00"],
  );
  assert.equal(
    account.windows[0].resets_at,
    Date.parse("2030-01-01T00:00:00Z") / 1000,
  );
});

test("commandcode: selected saved session takes precedence over API key", async () => {
  const context = fakeContext({
    ...configured,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: {
          commandcode: {
            apiKey: "saved-key",
            cookieSource: "manual",
            tokenAccounts: {
              activeIndex: 0,
              accounts: [{ token: "session=fake; other=retained" }],
            },
          },
        },
      }),
    },
    responses: responses(),
  });
  await commandcode.fetch(context);
  assert.equal(context.calls[0].headers.authorization, undefined);
  assert.equal(context.calls[0].headers.cookie, "session=fake; other=retained");
});

test("commandcode: nested windows, numeric dates, default usage and dropped monthly depletion", async () => {
  const context = fakeContext({
    ...configured,
    responses: [
      json({
        credits: {
          monthlyCredits: 0,
          monthlyCreditsGranted: 10,
          windowLimits: {
            fiveHour: { cap: 10, resetAt: 1893456000000 },
            weekly: { used: 2, cap: 10, resetAt: 1893456000 },
          },
        },
      }),
      json({}, 500),
    ],
  });
  const [account] = await commandcode.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [0, 20],
  );
  assert.deepEqual(
    account.windows.map((w) => w.resets_at),
    [1893456000, 1893456000],
  );
  assert.equal(account.blocked, true);
});

test("commandcode: missing grant keeps the remaining balance despite failed enrichment", async () => {
  for (const optional of [
    json({}, 401),
    json({}, 429),
    json({}, 500),
    new Response("not-json"),
  ]) {
    const [account] = await commandcode.fetch(
      fakeContext({
        ...configured,
        responses: [
          json({ credits: { monthlyCredits: "8.5", purchasedCredits: 2 } }),
          optional,
        ],
      }),
    );
    assert.deepEqual(
      account.windows.map((w) => w.value),
      ["$8.50", "$2.00"],
    );
    assert.equal(account.error, undefined);
  }
  const [reported] = await commandcode.fetch(
    fakeContext({
      ...configured,
      responses: [
        json({ credits: { monthlyCredits: 2, monthlyCreditsGranted: 20 } }),
        json({ success: true, data: { planId: "unknown" } }),
      ],
    }),
  );
  assert.equal(reported.windows[0].used_percent, 90);
});

test("commandcode: every request has a timeout and rejects redirects", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  await commandcode.fetch(context);
});

test("commandcode: optional enrichment tolerates refused and timed-out requests but preserves cancellation", async () => {
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
      await assert.rejects(commandcode.fetch(context), (e) => e === error);
    else assert.equal((await commandcode.fetch(context))[0].error, undefined);
  }
});

test("commandcode: saved API key is resolved from companion config", async () => {
  const env = Object.fromEntries(
    Object.entries(configured.env).filter(([name]) => !/KEY|TOKEN/.test(name)),
  );
  const context = fakeContext({
    env,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { commandcode: { apiKey: "saved-key" } },
      }),
    },
    responses: responses(),
  });
  await commandcode.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer saved-key");
});
