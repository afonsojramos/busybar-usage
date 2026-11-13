import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { opendesign } from "../src/providers/opendesign.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Synthetic counters follow CodexBar's provider fixture; dates are moved beyond NOW.
const fixture = {
  workspaceId: "workspace-fixture",
  eligible: true,
  windows: [
    {
      durationSeconds: 604800,
      usedCredits: 20,
      limitCredits: 100,
      resetsAt: "2030-01-08T00:00:00Z",
    },
    {
      durationSeconds: 18000,
      usedCredits: "5",
      limitCredits: "50",
      resetsAt: "2030-01-01T05:00:00Z",
    },
  ],
};
const configured = {
  env: {},
  files: {
    "/home/test/.config/busybar-usage/config.json":
      '{"providers":{"opendesign":{"cookieHeader":"__Secure-better-auth.session_token=fake-session"}}}',
  },
};
const responses = (body: unknown = fixture) => [json({ workspaceId: "workspace-fixture" }), json(body)];

test("opendesign: maps the CodexBar contract and sends the expected credential", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const [account] = await opendesign.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => w.name),
    ["5h", "7d"],
  );
  assert.deepEqual(
    account.windows.map((w) => w.used_percent ?? w.value),
    [10, 20],
  );
  assert.equal(context.calls[0].url, "https://amr-api.open-design.ai/api/v1/workspaces/current");
  assert.equal(context.calls[0].headers["cookie"], "__Secure-better-auth.session_token=fake-session");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
});

test("opendesign: missing credentials are not configured", async () => {
  await assert.rejects(opendesign.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`opendesign: HTTP ${status} requests sign-in`, async () => {
    const context = fakeContext({
      ...configured,
      responses: [json({}, status)],
    });
    const [account] = await opendesign.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("opendesign: rate limiting honors Retry-After", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(opendesign.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 120);
});

test("opendesign: malformed payloads and HTTP errors are sanitized", async () => {
  for (const response of [json({}), new Response("secret-body"), json({}, 500)]) {
    const context = fakeContext({
      ...configured,
      responses: [json({ workspaceId: "workspace-fixture" }), response],
    });
    await assert.rejects(
      opendesign.fetch(context),
      (e: unknown) => e instanceof HttpError && !e.message.includes("secret-body"),
    );
  }
});

test("opendesign: workspace header and second-request auth and rate limits", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  await opendesign.fetch(context);
  assert.equal(context.calls[1].headers["x-vela-workspace-id"], "workspace-fixture");
  for (const status of [401, 403, 429]) {
    const ctx = fakeContext({
      ...configured,
      responses: [json({ workspaceId: "workspace-fixture" }), json({}, status)],
    });
    if (status === 429) await assert.rejects(opendesign.fetch(ctx), RateLimited);
    else assert.equal((await opendesign.fetch(ctx))[0].error, "sign in");
  }
});

test("opendesign: rejects workspace mismatch, duplicates, invalid amounts and unsupported windows", async () => {
  for (const body of [
    { ...fixture, workspaceId: "other" },
    { ...fixture, eligible: false },
    { ...fixture, windows: [fixture.windows[0], fixture.windows[0]] },
    {
      ...fixture,
      windows: [{ durationSeconds: 18000, usedCredits: -1, limitCredits: 5 }],
    },
    {
      ...fixture,
      windows: [{ durationSeconds: 18000, usedCredits: 1, limitCredits: 0 }],
    },
    {
      ...fixture,
      windows: [{ durationSeconds: 60, usedCredits: 1, limitCredits: 5 }],
    },
  ]) {
    await assert.rejects(opendesign.fetch(fakeContext({ ...configured, responses: responses(body) })), HttpError);
  }
  const [account] = await opendesign.fetch(
    fakeContext({
      ...configured,
      responses: responses({
        ...fixture,
        windows: [
          {
            durationSeconds: 18000,
            usedCredits: 100,
            limitCredits: 100,
            resetsAt: "invalid",
          },
        ],
      }),
    }),
  );
  assert.equal(account.blocked, true);
  assert.equal(account.windows[0].resets_at, null);
});

test("opendesign: every request has a timeout and rejects redirects", async () => {
  const context = fakeContext({ ...configured, responses: responses() });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  await opendesign.fetch(context);
});
