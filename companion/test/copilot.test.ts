import assert from "node:assert/strict";
import { test } from "node:test";
import { copilot, parseUsage } from "../src/providers/copilot.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const files = { "/home/test/.codexbar/config.json": JSON.stringify({ providers: [{ id: "copilot", apiKey: "fake-token" }] }) };
// Derived from CodexBar's CopilotUsageModelsTests quota snapshots.
const usage = { quota_reset_date: "2026-12-01", quota_snapshots: {
  premium_interactions: { entitlement: 300, remaining: 240, percent_remaining: 80 },
  chat: { entitlement: 500, remaining: 250, percent_remaining: 50 },
} };
test("Copilot reads CodexBar token and premium/chat quotas", async () => {
  const context = fakeContext({ files, responses: [json(usage)] });
  const fetch = context.fetch;
  context.fetch = async (url, init) => { assert.ok(init?.signal instanceof AbortSignal); return fetch(url, init); };
  const [account] = await copilot.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent, w.resets_at]), [["Premium", 20, 1796083200], ["Chat", 50, 1796083200]]);
  assert.equal(context.calls[0].url, "https://api.github.com/copilot_internal/user");
  assert.deepEqual(context.calls[0].headers, { authorization: "token fake-token", accept: "application/json", "editor-version": "vscode/1.96.2", "editor-plugin-version": "copilot-chat/0.26.7", "user-agent": "GitHubCopilotChat/0.26.7", "x-github-api-version": "2025-04-01" });
});
test("Copilot missing token", async () => { await assert.rejects(copilot.fetch(fakeContext({})), NotConfigured); });
for (const status of [401, 403, 429, 500]) {
  test(`Copilot HTTP ${status}`, async () => {
    const context = fakeContext({ files, responses: [json({}, status, { "retry-after": "120" })] });
    if (status === 401 || status === 403) assert.equal((await copilot.fetch(context))[0].error, "sign in");
    else await assert.rejects(copilot.fetch(context), (e: unknown) => status === 429 ? e instanceof RateLimited && e.until === NOW + 120 : e instanceof HttpError);
  });
}
test("Copilot derives percentages and preserves over-quota", () => {
  assert.equal(parseUsage({ quota_snapshots: { premium_interactions: { entitlement: "300", remaining: "-30" } } }, NOW)?.[0].used_percent, 110);
});
test("Copilot monthly/limited fallback", () => {
  assert.deepEqual(parseUsage({ monthly_quotas: { completions: 2000, chat: 50 }, limited_user_quotas: { completions: 1000, chat: 0 } }, NOW)?.map((w) => w.used_percent), [50, 100]);
});
test("Copilot placeholders show credits without fake percent", () => {
  const windows = parseUsage({ token_based_billing: true, quota_snapshots: {
    premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, credits_used: 31 },
    chat: { entitlement: 0, remaining: 0, credits_used: 31 },
  } }, NOW);
  assert.deepEqual(windows?.map((w) => [w.name, w.used_percent, w.value]), [["Credits", null, "31 cr"]]);
  assert.deepEqual(parseUsage({ quota_snapshots: { chat: { unlimited: true } } }, NOW), []);
});
test("Copilot alternate snapshot keys", () => {
  assert.equal(parseUsage({ quota_snapshots: { completions: { percent_remaining: 75 } } }, NOW)?.[0].used_percent, 25);
});
test("Copilot rejects malformed and unknown bodies", async () => {
  for (const response of [new Response("fake-secret"), json({}), json({ quota_snapshots: { chat: { entitlement: 0, remaining: 0 } } })]) {
    await assert.rejects(copilot.fetch(fakeContext({ files, responses: [response] })), HttpError);
  }
});
test("Copilot ended subscriptions and exhausted quotas block", async () => {
  for (const body of [{ access_type_sku: "subscription_ended" }, { quota_snapshots: { chat: { percent_remaining: 0 } } }]) {
    assert.equal((await copilot.fetch(fakeContext({ files, responses: [json(body)] })))[0].blocked, true);
  }
});
