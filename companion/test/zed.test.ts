import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { zed } from "../src/providers/zed.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Derived from CodexBar's zed parser/fetcher fixtures, with fake identity and future resets.
const fixture = { plan: "pro", current_usage: { edit_predictions: { used: 25, limit: 100 }, token_spend: { spend_in_cents: 250, limit_in_cents: 1000 } } };
const configured = { files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { zed: { cookieSource: "manual", cookieHeader: "zed.session=fake" } } }) } };

test("zed: parses CodexBar-derived fixture", async () => {
  const context = fakeContext({ ...configured, responses: [json(fixture)] });
  const [account] = await zed.fetch(context);
  assert.equal(account.provider, "zed");
  assert.equal(account.windows[0].used_percent, 25);
  assert.ok(account.windows.length <= 2);
  assert.ok(context.calls.every(call => call.url.startsWith("https://")));
});
test("zed: missing credentials", async () => {
  await assert.rejects(zed.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403]) test(`zed: ${status} asks to sign in`, async () => {
  const [account] = await zed.fetch(fakeContext({ ...configured, responses: [json({}, status)] }));
  assert.equal(account.error, "sign in");
});
test("zed: rate limit honors Retry-After", async () => {
  await assert.rejects(zed.fetch(fakeContext({ ...configured, responses: [json({}, 429, { "retry-after": "120" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 120);
});
for (const response of [new Response("not json"), json({}), json({ secret: "never echo" }, 500)]) {
  test(`zed: invalid response ${response.status} is a sanitized HttpError`, async () => {
    await assert.rejects(zed.fetch(fakeContext({ ...configured, responses: [response] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("never echo"));
  });
}

test("Zed: editor uses user ID and Keychain token", async () => {
  const context = fakeContext({ platform: "darwin", files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { zed: { accountID: "42" } } }) },
    keychain: { "https://zed.dev/42": "fake-token" }, responses: [json({ user: { id: 42 }, plan: { plan_v3: "pro", has_overdue_invoices: true,
      usage: { edit_predictions: { used: 25, limit: { limited: 100 } } }, subscription_period: { started_at: "2026-11-01T00:00:00Z", ended_at: "2026-12-01T00:00:00Z" } } })] });
  const [account] = await zed.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "42 fake-token");
  assert.equal(account.windows[0].used_percent, 25);
  assert.equal(account.blocked, true);
});
test("Zed: unlimited predictions and unknown token cap", async () => {
  const context = fakeContext({ ...configured, responses: [json({ plan: "pro", current_usage: { edit_predictions: { used: 25, limit: null }, token_spend: { spend_in_cents: 250 } } })] });
  assert.deepEqual((await zed.fetch(context))[0].windows.map(w => w.value), ["unlimited", "$2.50"]);
});
test("Zed: rejects cross-origin custom-server credentials", async () => {
  const context = fakeContext({ files: { "/home/test/.config/zed/settings.json": JSON.stringify({ server_url: "https://custom.example", credentials_url: "https://zed.dev" }) } });
  await assert.rejects(zed.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});
