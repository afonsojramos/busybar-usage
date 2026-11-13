import assert from "node:assert/strict";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { test } from "node:test";
import { devin, parseUsage } from "../src/providers/devin.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { DEVIN_BEARER_TOKEN: "fake-token", DEVIN_ORGANIZATION: "org_12345678" };
const fixture = { daily_percentage: 0.12, weekly_percentage: 42, daily_reset_at: NOW + 1000, weekly_reset_at: (NOW + 7000) * 1000, hide_daily_quota: false };

test("Devin maps CodexBar current quota fixture and auth", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const [account] = await devin.fetch(context);
  assert.deepEqual(account?.windows.map((w) => [w.name, w.used_percent, w.resets_at]), [["1d", 12, NOW + 1000], ["7d", 42, NOW + 7000]]);
  assert.equal(context.calls[0]?.url, "https://app.devin.ai/api/org_12345678/billing/quota/usage");
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-token");
  assert.equal(context.calls[0]?.headers["x-cog-org-id"], "org_12345678");
});

test("Devin missing credentials and organization", async () => {
  await assert.rejects(devin.fetch(fakeContext({})), NotConfigured);
  await assert.rejects(devin.fetch(fakeContext({ env: { DEVIN_BEARER_TOKEN: "fake" } })), NotConfigured);
});

for (const status of [401, 403]) test(`Devin ${status} asks to sign in`, async () => {
  const [account] = await devin.fetch(fakeContext({ env, responses: [json({}, status)] }));
  assert.equal(account?.error, "sign in");
});

test("Devin 429 honors Retry-After", async () => {
  await assert.rejects(devin.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })), (e: unknown) => e instanceof RateLimited && e.until === NOW + 42);
});

test("Devin rejects malformed bodies", async () => {
  for (const response of [json({}), new Response("not json")]) await assert.rejects(devin.fetch(fakeContext({ env, responses: [response] })), HttpError);
});

test("Devin maps CodexBar nested quota fixture", () => {
  const result = parseUsage({ quota_usage: { daily_quota: { used: 3, limit: 10, reset_at: new Date((NOW + 300) * 1000).toISOString() }, weekly_quota: { remaining_percent: 0.25, next_reset_at: NOW + 400 } } }, NOW);
  assert.deepEqual(result?.map((w) => w.used_percent), [30, 75]);
});

test("Devin hides daily quota and retains extra balance", () => {
  const result = parseUsage({ ...fixture, hide_daily_quota: true, overage_balance_cents: 7087 }, NOW);
  assert.deepEqual(result?.map((w) => w.name), ["7d", "extra"]);
  assert.equal(result?.[1]?.value, "$70.87");
  assert.equal(parseUsage({ daily_percentage: 10, hide_daily_quota: true }, NOW), null);
  assert.equal(parseUsage({ hide_daily_quota: true, weekly_percentage: true }, NOW), null);
});

test("Devin uses saved manual authorization and slug paths", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { devin: { cookieSource: "manual", cookieHeader: "Authorization: Bearer fake-saved", workspaceID: "https://app.devin.ai/org/my-team/settings" } } }) }, responses: [json({}, 404), json(fixture)] });
  assert.equal((await devin.fetch(context))[0]?.windows.length, 2);
  assert.equal(context.calls[0]?.url, "https://app.devin.ai/api/org/my-team/billing/quota/usage");
  assert.equal(context.calls[1]?.url, "https://app.devin.ai/api/my-team/billing/quota/usage");
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-saved");
});

test("Devin reads encrypted desktop session without changing it", async () => {
  const key = pbkdf2Sync("fake-password", "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
  const encrypted = Buffer.concat([Buffer.from("v10"), cipher.update(JSON.stringify([{ accessToken: "fake-desktop" }])), cipher.final()]);
  const query = "SELECT key, value FROM ItemTable WHERE key LIKE 'secret://%' OR key LIKE 'devin.desktopShell.%';";
  const context = fakeContext({ platform: "darwin", keychain: { "Devin Safe Storage/Devin Key": "fake-password" }, sqlite: {
    [`/home/test/Library/Application Support/Devin/User/globalStorage/state.vscdb::${query}`]: [
      { key: 'secret://{"extensionId":"test","key":"windsurf_auth.sessions"}', value: JSON.stringify({ type: "Buffer", data: [...encrypted] }) },
      { key: "devin.desktopShell.state.org-12345678", value: "" },
    ],
  }, responses: [json(fixture)] });
  assert.equal((await devin.fetch(context))[0]?.windows[0]?.used_percent, 12);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-desktop");
});

test("Devin empty environment override does not reuse stored token", async () => {
  const context = fakeContext({ env: { DEVIN_BEARER_TOKEN: "", DEVIN_ORGANIZATION: "org_12345678" }, files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { devin: { cookieSource: "manual", cookieHeader: "Bearer saved" } } }) } });
  await assert.rejects(devin.fetch(context), NotConfigured);
});

test("Devin explicit empty token never consults desktop credentials", async () => {
  const context = fakeContext({ platform: "darwin", env: { DEVIN_BEARER_TOKEN: "", DEVIN_ORGANIZATION: "org_12345678" } });
  let readDesktop = false;
  context.querySqlite = async () => { readDesktop = true; return []; };
  await assert.rejects(devin.fetch(context), NotConfigured);
  assert.equal(readDesktop, false);
});
