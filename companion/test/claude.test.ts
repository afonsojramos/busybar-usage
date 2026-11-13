import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { claude } from "../src/providers/claude.ts";
import { NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const credentials = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: "test-access-token",
      expiresAt: (NOW + 3600) * 1000,
      scopes: ["user:inference", "user:profile"],
      ...overrides,
    },
  });

const usage = {
  five_hour: { utilization: 16.4, resets_at: "2026-11-13T17:30:00.000000+00:00" },
  seven_day: { utilization: 31, resets_at: "2026-11-20T02:00:00+00:00" },
  seven_day_opus: null,
};

const profile = JSON.stringify({ oauthAccount: { emailAddress: "someone@yld.com" } });

test("reads the Keychain login on macOS and reports both windows", async () => {
  const context = fakeContext({
    platform: "darwin",
    keychain: { "Claude Code-credentials": credentials() },
    files: { "/home/test/.claude.json": profile },
    responses: [json(usage)],
  });
  const [account] = await claude.fetch(context);
  assert.equal(account.account, "yld");
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent, w.resets_at]),
    [
      ["5h", 16, 1794591000],
      ["7d", 31, 1795140000],
    ],
  );
  assert.equal(context.calls[0].url, "https://api.anthropic.com/api/oauth/usage");
  assert.equal(context.calls[0].headers.authorization, "Bearer test-access-token");
  assert.equal(context.calls[0].headers["anthropic-beta"], "oauth-2025-04-20");
});

test("falls back to the credentials file, honouring CLAUDE_CONFIG_DIR", async () => {
  const context = fakeContext({
    env: { CLAUDE_CONFIG_DIR: "/cfg" },
    files: { "/cfg/.credentials.json": credentials(), "/cfg/.claude.json": profile },
    responses: [json(usage)],
  });
  const [account] = await claude.fetch(context);
  assert.equal(account.windows.length, 2);
});

test("an expired login asks to sign in without calling the API", async () => {
  const context = fakeContext({ files: { "/home/test/.claude/.credentials.json": credentials({ expiresAt: NOW * 1000 - 1 }) } });
  const [account] = await claude.fetch(context);
  assert.equal(account.error, "sign in");
  assert.equal(context.calls.length, 0);
});

test("a setup-token login cannot read usage", async () => {
  const context = fakeContext({ files: { "/home/test/.claude/.credentials.json": credentials({ scopes: ["user:inference"] }) } });
  const [account] = await claude.fetch(context);
  assert.equal(account.error, "no access");
});

test("no login means not configured", async () => {
  await assert.rejects(claude.fetch(fakeContext({})), NotConfigured);
});

test("a 429 waits for Retry-After", async () => {
  const context = fakeContext({
    files: { "/home/test/.claude/.credentials.json": credentials() },
    responses: [json({}, 429, { "retry-after": "120" })],
  });
  await assert.rejects(claude.fetch(context), (error: unknown) => error instanceof RateLimited && error.until === NOW + 120);
});

test("a rejected token asks to sign in", async () => {
  const context = fakeContext({
    files: { "/home/test/.claude/.credentials.json": credentials() },
    responses: [json({ error: "invalid" }, 401)],
  });
  const [account] = await claude.fetch(context);
  assert.equal(account.error, "sign in");
});
