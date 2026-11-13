import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { elevenlabs } from "../src/providers/elevenlabs.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const usage = {
  tier: "creator",
  character_count: 25000,
  character_limit: 100000,
  voice_slots_used: 2,
  voice_limit: 10,
  professional_voice_slots_used: 1,
  professional_voice_limit: 2,
  current_overage: {
    amount: "0",
    currency: "usd",
  },
  status: "active",
  next_character_count_reset_unix: 1893456000,
};
const extras: unknown[] = [];
const env = { ELEVENLABS_API_KEY: "fake-api-key" };
const responses = () => [json(usage), ...extras.map((body) => json(body))];

test("ElevenLabs: CodexBar-derived fixture and request", async () => {
  const context = fakeContext({ env, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.method ?? "GET", "GET");
    return fetch(input, init);
  };
  const [account] = await elevenlabs.fetch(context);
  assert.equal(account.provider, "elevenlabs");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.equal(account.blocked, false);
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent, w.value ?? null]),
    [
      ["30d", 25, null],
      ["voice", 20, null],
    ],
  );
  assert.equal(context.calls[0].url, "https://api.elevenlabs.io/v1/user/subscription");
  for (const call of context.calls) {
    assert.equal(call.headers["xi-api-key"], "fake-api-key");
    assert.equal(call.headers.accept, "application/json");
  }
  assert.ok(account.windows.every((w) => (w.value?.length ?? 0) <= 12));
});

test("ElevenLabs: missing credentials", async () => {
  await assert.rejects(elevenlabs.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) {
  test(`ElevenLabs: ${status} asks to sign in`, async () => {
    const [account] = await elevenlabs.fetch(
      fakeContext({ env, responses: [json({ secret: "private-body" }, status)] }),
    );
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });
}

for (const retry of [undefined, "120"]) {
  test(`ElevenLabs: rate limit ${retry ?? "default"}`, async () => {
    await assert.rejects(
      elevenlabs.fetch(
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
  test(`ElevenLabs: rejects invalid body ${body} safely`, async () => {
    await assert.rejects(
      elevenlabs.fetch(
        fakeContext({
          env,
          responses: [new Response(body), ...extras.map((value) => json(value))],
        }),
      ),
      (error: unknown) => error instanceof HttpError && !error.message.includes("private-body"),
    );
  });
}

test("ElevenLabs: HTTP errors omit response content", async () => {
  await assert.rejects(
    elevenlabs.fetch(fakeContext({ env, responses: [json({ secret: "private-body" }, 503)] })),
    (error: unknown) => error instanceof HttpError && error.status === 503 && !error.message.includes("private-body"),
  );
});

test("ElevenLabs: companion config supplies the API key", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { elevenlabs: { apiKey: "fake-api-key" } },
      }),
    },
    responses: responses(),
  });
  assert.equal((await elevenlabs.fetch(context))[0].windows.length, 2);
});

test("ElevenLabs: exhausted and past reset quotas", async () => {
  for (const [reset, expected] of [
    [NOW + 3600, 100],
    [NOW - 1, 0],
  ]) {
    const [account] = await elevenlabs.fetch(
      fakeContext({
        env,
        responses: [json({ ...usage, character_count: 150000, next_character_count_reset_unix: reset })],
      }),
    );
    assert.equal(account.windows[0].used_percent, expected);
    assert.equal(account.windows[0].minutes, 43200);
    assert.equal(account.windows[0].resets_at, reset);
    assert.equal(account.blocked, expected === 100);
  }
});

test("ElevenLabs: zero limit and absent slots do not invent quotas", async () => {
  const [account] = await elevenlabs.fetch(
    fakeContext({
      env: { XI_API_KEY: "fake-api-key" },
      responses: [json({ character_count: 10, character_limit: 0 })],
    }),
  );
  assert.equal(account.windows.length, 1);
  assert.equal(account.windows[0].used_percent, null);
});

for (const body of [
  { ...usage, character_count: "25" },
  { ...usage, character_count: 1.5 },
  { ...usage, voice_slots_used: "2" },
  { ...usage, next_character_count_reset_unix: "2030" },
  { ...usage, tier: 3 },
  { ...usage, current_overage: { amount: 1 } },
])
  test("ElevenLabs: rejects malformed subscription fields", async () => {
    await assert.rejects(elevenlabs.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  });

test("elevenlabs: malformed success strings do not look authenticated", async () => {
  await assert.rejects(
    elevenlabs.fetch(fakeContext({ env, responses: [json("sign in"), ...extras.map((value) => json(value))] })),
    HttpError,
  );
});

test("elevenlabs: CodexBar config key selection", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/codexbar/config.json": JSON.stringify({
        providers: [
          {
            id: "elevenlabs",
            tokenAccounts: { activeIndex: 1, accounts: [{ token: "unused-key" }, { token: "fake-api-key" }] },
          },
        ],
      }),
    },
    responses: responses(),
  });
  await elevenlabs.fetch(context);
  assert.equal(context.calls[0].headers["xi-api-key"], "fake-api-key");
});

for (const name of ["TypeError", "TimeoutError", "AbortError"]) {
  test(`elevenlabs: preserves transport failure ${name}`, async () => {
    const context = fakeContext({ env });
    const failure = new Error("request failed");
    failure.name = name;
    context.fetch = async () => {
      throw failure;
    };
    await assert.rejects(elevenlabs.fetch(context), (error: unknown) => error === failure);
  });
}

test("elevenlabs: primary environment name precedes its alias", async () => {
  const context = fakeContext({ env: { ...env, XI_API_KEY: "unused-key" }, responses: responses() });
  await elevenlabs.fetch(context);
  assert.equal(context.calls[0].headers["xi-api-key"], "fake-api-key");
});

for (const endpoint of [
  "http://example.com",
  "https://name:password@example.com",
  "https://example.com?secret=value",
]) {
  test("elevenlabs: rejects invalid endpoint overrides before sending credentials", async () => {
    const context = fakeContext({ env: { ...env, ELEVENLABS_API_URL: endpoint } });
    await assert.rejects(elevenlabs.fetch(context), HttpError);
    assert.equal(context.calls.length, 0);
  });
}
