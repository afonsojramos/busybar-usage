import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { synthetic } from "../src/providers/synthetic.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { SYNTHETIC_API_KEY: "fake-synthetic" };
const reset = new Date((NOW + 3600) * 1000).toISOString();
// Adapted from SyntheticPluginGoldenTests.plan weekly quota.
const usage = {
  subscription: { limit: 500, requests: 0 },
  search: { hourly: { limit: 250, requests: 5, renewsAt: reset } },
  planWeeklyLimit: { nextRegenAt: reset, percentRemaining: 99.47981765714286, nextRegenPercent: 2 },
};

for (const wrapped of [false, true]) {
  test(`Synthetic current plan ${wrapped ? "wrapped" : "root"}`, async () => {
    const context = fakeContext({ env, responses: [json(wrapped ? { data: usage } : usage)] });
    const [account] = await synthetic.fetch(context);
    assert.deepEqual(
      account.windows.map((w) => [w.name, w.minutes, w.used_percent, w.resets_at]),
      [
        ["1h", 60, 2, NOW + 3600],
        ["7d", 10080, 1, null],
      ],
    );
    assert.equal(account.account, "default");
    assert.equal(account.blocked, false);
    assert.equal(context.calls[0].url, "https://api.synthetic.new/v2/quotas");
    assert.equal(context.calls[0].headers.authorization, "Bearer fake-synthetic");
    assert.equal(context.calls[0].headers.accept, "application/json");
  });
}

test("Synthetic weekly percentage points below one remain nearly exhausted", async () => {
  for (const remaining of [0, 0.5, 1, 100]) {
    const [account] = await synthetic.fetch(
      fakeContext({ env, responses: [json({ planWeeklyLimit: { percentRemaining: remaining } })] }),
    );
    assert.equal(account.windows[0].used_percent, Math.round(100 - remaining));
    assert.equal(account.blocked, Math.round(100 - remaining) >= 100);
  }
});

test("Synthetic legacy fractional lanes, shortest two, and dropped exhaustion", async () => {
  const [account] = await synthetic.fetch(
    fakeContext({
      env,
      responses: [
        json({
          rollingFiveHourLimit: { percentRemaining: 0.75 },
          weeklyTokenLimit: { percentRemaining: 0 },
          search: { hourly: { limit: 250, requests: 5 } },
        }),
      ],
    }),
  );
  assert.deepEqual(
    account.windows.map((w) => [w.minutes, w.used_percent]),
    [
      [60, 2],
      [300, 25],
    ],
  );
  assert.equal(account.blocked, true);
});

test("Synthetic known search does not revive subscription", async () => {
  const [account] = await synthetic.fetch(
    fakeContext({ env, responses: [json({ subscription: { limit: 500, requests: 500 }, search: usage.search })] }),
  );
  assert.equal(account.windows.length, 1);
  assert.equal(account.blocked, false);
});

test("Synthetic legacy subscription falls back without guessing a window", async () => {
  const [account] = await synthetic.fetch(
    fakeContext({ env, responses: [json({ subscription: { limit: 500, requests: 10 } })] }),
  );
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.minutes, w.used_percent]),
    [["quota", null, 2]],
  );
});

test("Synthetic generic aliases, durations and dates", async () => {
  const fixtures = [
    {
      quotas: [
        { name: "Monthly", limit: 1000, used: 250, reset_at: reset },
        { name: "Daily", max: 200, remaining: 50, window_minutes: 1440 },
      ],
    },
    [
      { name: "Monthly", usage_percent: 0.25, resetsAt: (NOW + 3600) * 1000 },
      { name: "Daily", used: 150, left: 50, window: "1 day" },
    ],
    {
      data: {
        limits: {
          monthly: { label: "Monthly", percent_used: 25, expiresAt: NOW + 3600 },
          daily: { label: "Daily", remaining_percent: 0.25, periodHours: 24 },
        },
      },
    },
  ];
  for (const fixture of fixtures) {
    const [account] = await synthetic.fetch(fakeContext({ env, responses: [json(fixture)] }));
    assert.deepEqual(
      account.windows.map((w) => [w.name, w.minutes, w.used_percent]),
      [
        ["1d", 1440, 75],
        ["30d", 43200, 25],
      ],
    );
    assert.equal(account.windows[1].resets_at, NOW + 3600);
  }
});

test("Synthetic reads config API keys and uses a request timeout", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { synthetic: { apiKey: "fake-config" } },
      }),
    },
  });
  let signal: AbortSignal | null | undefined;
  context.fetch = async (_input, init) => {
    signal = init?.signal;
    return json(usage);
  };
  await synthetic.fetch(context);
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
});

test("Synthetic missing key", async () => {
  await assert.rejects(synthetic.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403]) {
  test(`Synthetic HTTP ${status} asks to sign in`, async () => {
    const [account] = await synthetic.fetch(fakeContext({ env, responses: [json({}, status)] }));
    assert.equal(account.error, "sign in");
  });
}
for (const delay of [null, "45"]) {
  test(`Synthetic 429 delay ${delay}`, async () => {
    await assert.rejects(
      synthetic.fetch(fakeContext({ env, responses: [json({}, 429, delay ? { "retry-after": delay } : {})] })),
      (error: unknown) => error instanceof RateLimited && error.until === NOW + (delay ? 45 : 300),
    );
  });
}
for (const response of [
  json({}, 500),
  json({}),
  json(null),
  json({ quotas: [{ limit: 0 }] }),
  new Response("fake-secret"),
]) {
  test(`Synthetic rejects invalid response ${response.status} ${response.bodyUsed}`, async () => {
    await assert.rejects(
      synthetic.fetch(fakeContext({ env, responses: [response] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("fake-secret"),
    );
  });
}

test("Synthetic labels the account from a supplied response email", async () => {
  for (const body of [{ ...usage, email: "fake@example.org" }, { data: { ...usage, email: "fake@example.org" } }]) {
    const [account] = await synthetic.fetch(fakeContext({ env, responses: [json(body)] }));
    assert.equal(account.account, "example");
  }
});

for (const field of ["nextRegenAt", "next_regen_at", "nextTickAt", "next_tick_at"]) {
  for (const offset of [-60, 60]) {
    test(`Synthetic partial regeneration ${field} ${offset} is not a full reset`, async () => {
      const [account] = await synthetic.fetch(
        fakeContext({
          env,
          responses: [
            json({
              planWeeklyLimit: {
                percentRemaining: 1,
                nextRegenPercent: 2,
                [field]: new Date((NOW + offset) * 1000).toISOString(),
              },
            }),
          ],
        }),
      );
      assert.equal(account.windows[0].used_percent, 99);
      assert.equal(account.windows[0].resets_at, null);
    });
  }
}

test("Synthetic preserves actual reset dates alongside partial regeneration", async () => {
  const [account] = await synthetic.fetch(
    fakeContext({
      env,
      responses: [
        json({
          planWeeklyLimit: {
            percentRemaining: 1,
            nextRegenPercent: 2,
            nextRegenAt: new Date((NOW - 60) * 1000).toISOString(),
            resetsAt: reset,
          },
        }),
      ],
    }),
  );
  assert.equal(account.windows[0].used_percent, 99);
  assert.equal(account.windows[0].resets_at, NOW + 3600);
});
