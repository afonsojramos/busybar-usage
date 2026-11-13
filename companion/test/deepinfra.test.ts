import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { deepinfra } from "../src/providers/deepinfra.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const usage = {
  stripe_balance: -99.75,
  recent: 3.94,
  limit: 20,
};
const extras: unknown[] = [{ months: [{ period: "2026.07", total_cost: 394 }] }];
const env = { DEEPINFRA_API_KEY: "fake-api-key" };
const responses = () => [json(usage), ...extras.map((body) => json(body))];

test("DeepInfra: CodexBar-derived fixture and request", async () => {
  const context = fakeContext({ env, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.method ?? "GET", "GET");
    return fetch(input, init);
  };
  const [account] = await deepinfra.fetch(context);
  assert.equal(account.provider, "deepinfra");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.equal(account.blocked, false);
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent, w.value ?? null]),
    [
      ["cycle", 20, null],
      ["bal", null, "$95.81"],
    ],
  );
  assert.equal(context.calls[0].url, "https://api.deepinfra.com/payment/checklist?compute_owed=true");
  for (const call of context.calls) {
    assert.equal(call.headers["authorization"], "Bearer fake-api-key");
    assert.equal(call.headers.accept, "application/json");
  }
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});

test("DeepInfra: missing credentials", async () => {
  await assert.rejects(deepinfra.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`DeepInfra: ${status} asks to sign in`, async () => {
    const [account] = await deepinfra.fetch(
      fakeContext({ env, responses: [json({ secret: "private-body" }, status)] }),
    );
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });
}

for (const retry of [undefined, "120"]) {
  test(`DeepInfra: rate limit ${retry ?? "default"}`, async () => {
    await assert.rejects(
      deepinfra.fetch(
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
  test(`DeepInfra: rejects invalid body ${body} safely`, async () => {
    await assert.rejects(
      deepinfra.fetch(
        fakeContext({
          env,
          responses: [new Response(body), ...extras.map((value) => json(value))],
        }),
      ),
      (error: unknown) => error instanceof HttpError && !error.message.includes("private-body"),
    );
  });
}

test("DeepInfra: HTTP errors omit response content", async () => {
  await assert.rejects(
    deepinfra.fetch(fakeContext({ env, responses: [json({ secret: "private-body" }, 503)] })),
    (error: unknown) => error instanceof HttpError && error.status === 503 && !error.message.includes("private-body"),
  );
});

test("DeepInfra: companion config supplies the API key", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { deepinfra: { apiKey: "fake-api-key" } },
      }),
    },
    responses: responses(),
  });
  assert.equal((await deepinfra.fetch(context))[0].windows.length, 2);
});

test("DeepInfra: both required requests use their billing paths", async () => {
  const context = fakeContext({ env, responses: responses() });
  await deepinfra.fetch(context);
  assert.equal(context.calls[1].url, "https://api.deepinfra.com/payment/usage?from=current");
});

test("DeepInfra: suspension, debt, no limit and empty monthly usage", async () => {
  for (const [checklist, expected, blocked] of [
    [{ stripe_balance: 2.75, recent: 7 }, "$9.75", true],
    [{ stripe_balance: -5, recent: 1, suspended: true }, "$4.00", true],
    [{ stripe_balance: -5, recent: 1 }, "$4.00", false],
  ] as const) {
    const [account] = await deepinfra.fetch(
      fakeContext({ env: { DEEPINFRA_TOKEN: "fake-api-key" }, responses: [json(checklist), json({ months: [] })] }),
    );
    assert.equal(account.windows[0].value, expected);
    assert.equal(account.blocked, blocked);
    assert.equal(account.windows[1].name, "spent");
    assert.equal(account.windows[1].value, `$${checklist.recent.toFixed(2)}`);
  }
});

for (const status of [401, 403, 429, 503])
  test(`DeepInfra: required usage error ${status}`, async () => {
    const context = fakeContext({ env, responses: [json(usage), json({}, status)] });
    if (status === 401 || status === 403) assert.equal((await deepinfra.fetch(context))[0].error, "sign in");
    else await assert.rejects(deepinfra.fetch(context), status === 429 ? RateLimited : HttpError);
  });

for (const body of [
  { ...usage, stripe_balance: "5" },
  { ...usage, suspended: 1 },
  { ...usage, limit: "20" },
  { ...usage, stripe_balance: 1e308, recent: 1e308 },
])
  test("DeepInfra: rejects malformed checklist", async () => {
    await assert.rejects(
      deepinfra.fetch(fakeContext({ env, responses: [json(body), ...extras.map((v) => json(v))] })),
      HttpError,
    );
  });
for (const body of [{}, { months: [{}] }, { months: [{ period: "2026.07", total_cost: "394" }] }]) {
  test("DeepInfra: validates monthly rows", async () => {
    await assert.rejects(deepinfra.fetch(fakeContext({ env, responses: [json(usage), json(body)] })), HttpError);
  });
}

test("deepinfra: malformed success strings do not look authenticated", async () => {
  await assert.rejects(
    deepinfra.fetch(fakeContext({ env, responses: [json("sign in"), ...extras.map((value) => json(value))] })),
    HttpError,
  );
});

test("deepinfra: CodexBar config key selection", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/codexbar/config.json": JSON.stringify({
        providers: [
          {
            id: "deepinfra",
            tokenAccounts: { activeIndex: 1, accounts: [{ token: "unused-key" }, { token: "fake-api-key" }] },
          },
        ],
      }),
    },
    responses: responses(),
  });
  await deepinfra.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});

for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
  test(`deepinfra: preserves transport failure ${name}`, async () => {
    const context = fakeContext({ env });
    const failure = new Error("request failed");
    failure.name = name;
    context.fetch = async () => {
      throw failure;
    };
    await assert.rejects(deepinfra.fetch(context), (error: unknown) => error === failure);
  });
}

test("deepinfra: primary environment name precedes its alias", async () => {
  const context = fakeContext({ env: { ...env, DEEPINFRA_TOKEN: "unused-key" }, responses: responses() });
  await deepinfra.fetch(context);
  assert.equal(context.calls[0].headers["authorization"], "Bearer fake-api-key");
});

test("DeepInfra: large recent spend stays finite when months are empty", async () => {
  const [account] = await deepinfra.fetch(
    fakeContext({ env, responses: [json({ stripe_balance: -1e308, recent: 1e308 }), json({ months: [] })] }),
  );
  assert.equal(account.windows[1].value, "$1e+308");
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});
