import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { muse } from "../src/providers/muse.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const credentials = {
  files: { "/home/test/.config/muse/auth.json": '{"providers": {"meta": {"access_token": "dca:fake"}}}' },
};
// Based on CodexBar's muse plugin fixtures, with reset times moved after the test clock.
const happy = () => [
  json({
    is_subs_active: true,
    user_email: "ada@example.com",
    subs_tier_name: "Muse Code Power Usage",
    subs_usage: {
      window: { used_percent: 96, window_duration_mins: 300, resets_at: NOW + 3600 },
      weekly: { used_percent: 40, resets_at: NOW + 86400 },
    },
  }),
];

test("muse: CodexBar fixture", async () => {
  const ctx = fakeContext({ ...credentials, responses: happy() });
  const [account] = await muse.fetch(ctx);
  assert.equal(account.error, undefined);
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [96, 40],
  );
  assert.equal(account.account, "example");
});

test("muse: missing credentials", async () => {
  await assert.rejects(muse.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403])
  test(`muse: ${status} requires sign in`, async () => {
    const ctx = fakeContext({ ...credentials, responses: [json({ private: "must not leak" }, status)] });
    const [account] = await muse.fetch(ctx);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
  });

test("muse: rate limit", async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({}, 429, { "retry-after": "17" })] });
  await assert.rejects(muse.fetch(ctx), (e: unknown) => e instanceof RateLimited && e.until === NOW + 17);
});

test("muse: invalid body is sanitized", async () => {
  const ctx = fakeContext({ ...credentials, responses: [new Response("private malformed body")] });
  await assert.rejects(muse.fetch(ctx), (e: unknown) => e instanceof HttpError && !e.message.includes("private"));
});

test("muse: Keychain token fallback", async () => {
  const ctx = fakeContext({
    platform: "darwin",
    keychain: { "ai.meta.dev.credentials/meta": JSON.stringify({ access_token: "dca:keychain-fake" }) },
    responses: happy(),
  });
  await muse.fetch(ctx);
  assert.equal(ctx.calls[0].headers.authorization, "Bearer dca:keychain-fake");
});

test("muse: billing, inactive and missing windows", async () => {
  for (const [body, error] of [
    [{ is_subs_active: false }, "no plan"],
    [{ require_payment: true }, "billing"],
    [{ is_subs_active: true }, undefined],
  ] as const) {
    const account = (await muse.fetch(fakeContext({ ...credentials, responses: [json(body)] })))[0];
    assert.equal(account.error, error);
    assert.deepEqual(account.windows, []);
  }
});

test("muse: selected browser team matches CLI identity and tier", async () => {
  const files = {
    ...credentials.files,
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({
      providers: { muse: { cookieSource: "manual", cookieHeader: "llama_dev_sess=fake", workspaceID: "7" } },
    }),
  };
  const ctx = fakeContext({
    files,
    responses: [
      json({ is_subs_active: true, user_email: "ada@example.com", subs_tier_name: "Power" }),
      json({ email: "ada@example.com" }),
      json({ teams: [{ team_id: 7, team_name: "Team" }] }),
      json({
        subscription_quota: {
          tier: "Power",
          weekly_resets_at: NOW + 86400,
          weekly_weighted_used: "40",
          weekly_weighted_limit: "100",
          window_duration_secs: 18000,
          window_resets_at: null,
          window_weighted_used: "0",
          window_weighted_limit: "100",
        },
      }),
    ],
  });
  assert.deepEqual(
    (await muse.fetch(ctx))[0].windows.map((w) => w.used_percent),
    [0, 40],
  );
  assert.equal(ctx.calls[1].headers.authorization, undefined);
});

test("muse: local token history excludes cached tokens and duplicate events", async () => {
  const root = "/home/test/.local/share/muse/sessions";
  const dirs = {
    [root]: ["2026"],
    [`${root}/2026`]: ["11"],
    [`${root}/2026/11`]: ["13"],
    [`${root}/2026/11/13`]: ["session"],
    [`${root}/2026/11/13/session`]: ["session.jsonl"],
  };
  const record = JSON.stringify({
    schema_version: 1,
    id: "turn",
    record_type: "event",
    payload_type: "runtime.session",
    payload_schema_version: 1,
    recorded_at: NOW * 1e6,
    payload: {
      event: {
        kind: "model_completed",
        usage: { input_tokens: 34893, output_tokens: 229, cached_tokens: 34000, reasoning_tokens: 52 },
      },
    },
  });
  const files = { ...credentials.files, [`${root}/2026/11/13/session/session.jsonl`]: `${record}\n${record}` };
  const ctx = fakeContext({ files, dirs, responses: [json({ is_subs_active: true })] });
  assert.equal((await muse.fetch(ctx))[0].windows[0].value, "35.1K tok");
});

test("muse: mismatched browser identity cannot supply quota", async () => {
  const files = {
    ...credentials.files,
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({
      providers: { muse: { cookieSource: "manual", cookieHeader: "llama_dev_sess=fake", workspaceID: "7" } },
    }),
  };
  const ctx = fakeContext({
    files,
    responses: [
      json({ is_subs_active: true, user_email: "ada@example.com", subs_tier_name: "Power" }),
      json({ email: "other@example.com" }),
    ],
  });
  assert.deepEqual((await muse.fetch(ctx))[0].windows, []);
  assert.equal(ctx.calls.length, 2);
});

test("muse: rejects invalid quota shapes instead of inventing usage", async () => {
  for (const subs_usage of [
    {},
    { window: { used_percent: "96", window_duration_mins: 300 }, weekly: { used_percent: 40 } },
  ]) {
    await assert.rejects(
      muse.fetch(fakeContext({ ...credentials, responses: [json({ is_subs_active: true, subs_usage })] })),
      HttpError,
    );
  }
});
