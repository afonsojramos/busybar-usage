import assert from "node:assert/strict";
import { test } from "node:test";
import { opencode, parseOpenCodeSubscription } from "../src/providers/opencode.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const files = (cookie = "__Host-console_session=fake-session", workspaceID: string | null = "org_test") => ({
  "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { opencode: { cookieHeader: cookie, ...(workspaceID === null ? {} : { workspaceID }) } } }),
});
// CodexBar OpenCodeGoConsoleMigrationTests meter shape, retaining only shortest two windows.
const meters = { access: { endsAt: "2026-12-01T00:00:00Z", meters: {
  fiveHour: { usedMicroCents: "1700000", limitMicroCents: "10000000", resetsAt: "2026-12-01T00:00:00Z" },
  week: { usedMicroCents: "7500000", limitMicroCents: "10000000" }, month: { usedMicroCents: "100", limitMicroCents: "1000" },
} } };
test("OpenCode maps Console microcent meters", async () => {
  const context = fakeContext({ files: files(), responses: [json(meters)] });
  const [account] = await opencode.fetch(context);
  assert.deepEqual(account.windows.map(w => [w.minutes, w.used_percent]), [[300, 17], [10080, 75]]);
  assert.equal(account.windows[1].resets_at, null);
  assert.equal(context.calls[0].url, "https://opencode.ai/console/api/go/status");
  assert.equal(context.calls[0].headers["x-org-id"], "org_test");
});
test("OpenCode discovers Console workspace", async () => {
  const context = fakeContext({ files: files("__Host-console_session=fake-session", null), responses: [json([{ id: "org_found" }]), json(meters)] });
  await opencode.fetch(context);
  assert.equal(context.calls[1].headers["x-org-id"], "org_found");
});
test("OpenCode missing cookies", async () => { await assert.rejects(opencode.fetch(fakeContext({})), NotConfigured); });
for (const status of [401, 403]) test(`OpenCode ${status} signs in`, async () => {
  const [account] = await opencode.fetch(fakeContext({ files: files(), responses: [json({}, status)] }));
  assert.equal(account.error, "sign in");
});
test("OpenCode 429 backs off", async () => {
  await assert.rejects(opencode.fetch(fakeContext({ files: files(), responses: [json({}, 429, { "retry-after": "60" })] })),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 60);
});
for (const response of [() => json({}), () => new Response("not-json"), () => json({}, 502)]) test("OpenCode rejects invalid responses", async () => {
  await assert.rejects(opencode.fetch(fakeContext({ files: files(), responses: [response()] })), HttpError);
});
test("OpenCode PAYG confirms no Go subscription before spend", async () => {
  const context = fakeContext({ files: files(), responses: [json(null), json({ hasGoSubscription: false }),
    json({ mode: "pay-as-you-go", balanceMicroCents: "1250000000" }), json({ totalCostMicroCents: "325000000" })] });
  const [account] = await opencode.fetch(context);
  assert.deepEqual(account.windows.map(w => [w.name, w.value]), [["30d", "$3.25"], ["balance", "$12.50"]]);
  assert.match(context.calls[3].url, /summary\?range=30d$/);
});
test("OpenCode parses legacy server-function without evaluating it", async () => {
  const text = '$R[16]($R[30],$R[41]={rollingUsage:$R[42]={status:"ok",resetInSec:5944,usagePercent:17},weeklyUsage:$R[43]={status:"ok",resetInSec:278201,usagePercent:75}});';
  const context = fakeContext({ files: files("auth=fake-session"), responses: [new Response(text)] });
  const [account] = await opencode.fetch(context);
  assert.deepEqual(account.windows.map(w => [w.used_percent, w.resets_at]), [[17, NOW + 5944], [75, NOW + 278201]]);
  assert.equal(context.calls[0].headers["x-server-id"], "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4");
});
test("OpenCode JSON fractional and absolute reset parsing", () => {
  const result = parseOpenCodeSubscription(JSON.stringify({ usage: { rollingUsage: { usagePercent: .25, resetAt: new Date((NOW + 3600) * 1000).toISOString() }, weeklyUsage: { used: 50, limit: 200, resetInSec: 7200 } } }), NOW);
  assert.deepEqual(result?.map(w => [w.used_percent, w.resets_at]), [[25, NOW + 3600], [25, NOW + 7200]]);
});
test("OpenCode rejects foreign workspace URL before requests", async () => {
  const context = fakeContext({ files: files("auth=fake-session", "https://evil.test/workspace/wrk_fake") });
  await assert.rejects(opencode.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});
test("OpenCode legacy PAYG reads nested customer fixed-point amounts", async () => {
  const context = fakeContext({ files: files("auth=fake-session"), responses: [new Response("null"), json({ data: { customer: { customerID: "cus_TEST", monthlyUsage: 1500000000, monthlyLimit: 20, balance: 1250000000, subscription: null } } })] });
  const [account] = await opencode.fetch(context);
  assert.deepEqual(account.windows.map(w => [w.name, w.used_percent, w.value]), [["30d", 75, undefined], ["balance", null, "$12.50"]]);
});
test("OpenCode legacy PAYG rejects unrelated monthlyUsage", async () => {
  const context = fakeContext({ files: files("auth=fake-session"), responses: [new Response("null"), json({ monthlyUsage: 1500000000 })] });
  await assert.rejects(opencode.fetch(context), HttpError);
});
test("OpenCode cached rejection advances to configured/browser session", async () => {
  const context = fakeContext({ files: files(), keychain: { "com.steipete.codexbar.cache/cookie.opencode": JSON.stringify({ cookieHeader: "__Host-console_session=expired-fake" }) }, responses: [json({}, 401), json(meters)] });
  await opencode.fetch(context);
  assert.deepEqual(context.calls.map(call => call.headers.cookie), ["__Host-console_session=expired-fake", "__Host-console_session=fake-session"]);
});
