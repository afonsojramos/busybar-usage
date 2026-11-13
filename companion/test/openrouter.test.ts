import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { openrouter } from "../src/providers/openrouter.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const usage = {
  data: {
    total_credits: 100,
    total_usage: 25,
  },
};
const extras: unknown[] = [
  { data: { limit: 20, limit_remaining: 15, limit_reset: "weekly", usage: 12, usage_weekly: 9 } },
];
const env = { OPENROUTER_API_KEY: "fake-api-key" };
const responses = () => [json(usage), ...extras.map((body) => json(body))];

test("OpenRouter: CodexBar-derived fixture and request", async () => {
  const context = fakeContext({ env, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.method ?? "GET", "GET");
    return fetch(input, init);
  };
  const [account] = await openrouter.fetch(context);
  assert.equal(account.provider, "openrouter");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.equal(account.blocked, false);
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent, w.value ?? null]),
    [
      ["7d", 25, null],
      ["bal", null, "$75.00"],
    ],
  );
  assert.equal(context.calls[0].url, "https://openrouter.ai/api/v1/credits");
  for (const call of context.calls) {
    assert.equal(call.headers["authorization"], "Bearer fake-api-key");
    assert.equal(call.headers.accept, "application/json");
  }
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});

test("OpenRouter: missing credentials", async () => {
  await assert.rejects(openrouter.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`OpenRouter: ${status} asks to sign in`, async () => {
    const [account] = await openrouter.fetch(
      fakeContext({ env, responses: [json({ secret: "private-body" }, status)] }),
    );
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });
}

for (const retry of [undefined, "120"]) {
  test(`OpenRouter: rate limit ${retry ?? "default"}`, async () => {
    await assert.rejects(
      openrouter.fetch(
        fakeContext({
          env,
          responses: [json({}, 429, retry ? { "retry-after": retry } : {})],
        }),
      ),
      (error: unknown) => error instanceof RateLimited && error.until === NOW + (retry ? 120 : 300),
    );
  });
}

for (const body of ["private-body", "null", "[]", "{}"]) {
  test(`OpenRouter: rejects invalid body ${body} safely`, async () => {
    await assert.rejects(
      openrouter.fetch(
        fakeContext({
          env,
          responses: [new Response(body), ...extras.map((value) => json(value))],
        }),
      ),
      (error: unknown) => error instanceof HttpError && !error.message.includes("private-body"),
    );
  });
}

test("OpenRouter: HTTP errors omit response content", async () => {
  await assert.rejects(
    openrouter.fetch(fakeContext({ env, responses: [json({ secret: "private-body" }, 503)] })),
    (error: unknown) => error instanceof HttpError && error.status === 503 && !error.message.includes("private-body"),
  );
});

test("OpenRouter: companion config supplies the API key", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { openrouter: { apiKey: "fake-api-key" } },
      }),
    },
    responses: responses(),
  });
  assert.equal((await openrouter.fetch(context))[0].windows.length, 2);
});

test("OpenRouter: quota precedence and real reset lengths", async () => {
  for (const [data, minutes, percent] of [
    [{ limit: 20, limit_remaining: 30, usage: 99, limit_reset: "daily" }, 1440, 0],
    [{ limit: 20, limit_reset: "weekly", usage_weekly: 10, usage: 99 }, 10080, 50],
    [{ limit: 20, limit_reset: "monthly", usage_monthly: 5, usage: 99 }, 43200, 25],
    [{ limit: 20, limit_reset: "daily", usage: 10 }, 1440, 50],
    [{ limit: 20, usage: 20 }, null, 100],
  ] as const) {
    const [account] = await openrouter.fetch(fakeContext({ env, responses: [json(usage), json({ data })] }));
    assert.equal(account.windows[0].minutes, minutes);
    assert.equal(account.windows[0].used_percent, percent);
    assert.equal(account.blocked, percent === 100);
  }
});

test("OpenRouter: uncapped keys keep balance without inventing a quota", async () => {
  const [account] = await openrouter.fetch(
    fakeContext({ env, responses: [json(usage), json({ data: { limit: null, usage: 25 } })] }),
  );
  assert.deepEqual(
    account.windows.map((w) => w.value),
    ["$75.00"],
  );
});

test("OpenRouter: optional identifying headers and HTTPS override", async () => {
  const context = fakeContext({
    env: {
      ...env,
      OPENROUTER_API_URL: "openrouter.ai/api/v1/",
      OPENROUTER_HTTP_REFERER: "https://client.example",
      OPENROUTER_X_TITLE: "Usage",
    },
    responses: responses(),
  });
  await openrouter.fetch(context);
  assert.equal(context.calls[0].url, "https://openrouter.ai/api/v1/credits");
  assert.equal(context.calls[0].headers["http-referer"], "https://client.example");
  assert.equal(context.calls[0].headers["x-title"], "Usage");
});

for (const data of [{ limit: "20" }, { limit: 20, limit_remaining: "15" }, { limit_reset: 2 }]) {
  test("OpenRouter: invalid key data is an HTTP error", async () => {
    await assert.rejects(openrouter.fetch(fakeContext({ env, responses: [json(usage), json({ data })] })), HttpError);
  });
}
for (const status of [401, 403, 429, 503])
  test(`OpenRouter: key endpoint status ${status}`, async () => {
    const context = fakeContext({ env, responses: [json(usage), json({}, status)] });
    if (status === 401 || status === 403) assert.equal((await openrouter.fetch(context))[0].error, "sign in");
    else await assert.rejects(openrouter.fetch(context), status === 429 ? RateLimited : HttpError);
  });

test("OpenRouter: CodexBar spending-cap fixture keeps cap separate from balance", async () => {
  const [account] = await openrouter.fetch(
    fakeContext({
      env,
      responses: [
        json({ data: { total_credits: 5, total_usage: 3.1 } }),
        json({ data: { limit: 30, limit_remaining: 30, limit_reset: "monthly", usage: 0, usage_monthly: 0 } }),
      ],
    }),
  );
  assert.deepEqual(
    account.windows.map((w) => [w.used_percent, w.value]),
    [
      [0, undefined],
      [null, "$1.90"],
    ],
  );
});

test("openrouter: malformed success strings do not look authenticated", async () => {
  await assert.rejects(
    openrouter.fetch(fakeContext({ env, responses: [json("sign in"), ...extras.map((value) => json(value))] })),
    HttpError,
  );
});

test("openrouter: CodexBar config key selection", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/codexbar/config.json": JSON.stringify({
        providers: [
          {
            id: "openrouter",
            tokenAccounts: { activeIndex: 1, accounts: [{ token: "unused-key" }, { token: "fake-api-key" }] },
          },
        ],
      }),
    },
    responses: responses(),
  });
  await openrouter.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});

for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
  test(`openrouter: preserves transport failure ${name}`, async () => {
    const context = fakeContext({ env });
    const failure = new Error("request failed");
    failure.name = name;
    context.fetch = async () => {
      throw failure;
    };
    await assert.rejects(openrouter.fetch(context), (error: unknown) => error === failure);
  });
}

for (const endpoint of [
  "https://example.com",
  "http://openrouter.ai",
  "https://name:password@openrouter.ai",
  "https://openrouter.ai?secret=value",
]) {
  test("openrouter: rejects invalid endpoint overrides before sending credentials", async () => {
    const context = fakeContext({ env: { ...env, OPENROUTER_API_URL: endpoint } });
    await assert.rejects(openrouter.fetch(context), HttpError);
    assert.equal(context.calls.length, 0);
  });
}
