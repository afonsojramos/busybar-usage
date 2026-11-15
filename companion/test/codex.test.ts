import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { codex } from "../src/providers/codex.ts";
import { NotConfigured } from "../src/providers/types.ts";
import { fakeContext, json, jwt, NOW } from "./helpers.ts";

const auth = (exp: number) =>
  JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      access_token: jwt({ exp }),
      id_token: jwt({ email: "someone@gmail.com" }),
      refresh_token: "refresh",
      account_id: "acct-1",
    },
  });

const usage = {
  plan_type: "pro",
  rate_limit: {
    primary_window: { used_percent: 73, limit_window_seconds: 604800, reset_after_seconds: 1000, reset_at: NOW + 1000 },
    secondary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 100, reset_at: NOW + 100 },
  },
};

test("reads auth.json and reports windows shortest first", async () => {
  const context = fakeContext({ files: { "/home/test/.codex/auth.json": auth(NOW + 3600) }, responses: [json(usage)] });
  const [account] = await codex.fetch(context);
  assert.equal(account.account, "gmail");
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent]),
    [
      ["5h", 12],
      ["7d", 73],
    ],
  );
  assert.equal(context.calls[0].headers["chatgpt-account-id"], "acct-1");
});

test("honours CODEX_HOME", async () => {
  const context = fakeContext({
    env: { CODEX_HOME: "/codex" },
    files: { "/codex/auth.json": auth(NOW + 3600) },
    responses: [json(usage)],
  });
  const [account] = await codex.fetch(context);
  assert.equal(account.windows.length, 2);
});

test("an expired token asks to sign in without calling the API", async () => {
  const context = fakeContext({ files: { "/home/test/.codex/auth.json": auth(NOW - 1) } });
  const [account] = await codex.fetch(context);
  assert.equal(account.error, "sign in");
  assert.equal(context.calls.length, 0);
});

test("a full window marks the account blocked", async () => {
  const full = {
    rate_limit: { primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: NOW + 50 } },
  };
  const context = fakeContext({ files: { "/home/test/.codex/auth.json": auth(NOW + 3600) }, responses: [json(full)] });
  const [account] = await codex.fetch(context);
  assert.equal(account.blocked, true);
});

test("an API-key-only auth.json is not a usage login", async () => {
  const context = fakeContext({
    files: { "/home/test/.codex/auth.json": JSON.stringify({ OPENAI_API_KEY: "sk-test" }) },
  });
  await assert.rejects(codex.fetch(context), NotConfigured);
});
