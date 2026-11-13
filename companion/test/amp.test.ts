import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { amp } from "../src/providers/amp.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Derived from CodexBar's amp parser/fetcher fixtures, with fake identity and future resets.
const fixture = { ok: true, result: { displayText: "Signed in as test@example.com\nAmp Free: 80% remaining today (resets daily)\nIndividual credits: $12.40 remaining" } };
const configured = { env: { AMP_API_KEY: "fake-key" } };

test("amp: parses CodexBar-derived fixture", async () => {
  const context = fakeContext({ ...configured, responses: [json(fixture)] });
  const [account] = await amp.fetch(context);
  assert.equal(account.provider, "amp");
  assert.equal(account.windows[0].used_percent, 20);
  assert.ok(account.windows.length <= 2);
  assert.ok(context.calls.every(call => call.url.startsWith("https://")));
});
test("amp: missing credentials", async () => {
  await assert.rejects(amp.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403]) test(`amp: ${status} asks to sign in`, async () => {
  const [account] = await amp.fetch(fakeContext({ ...configured, responses: [json({}, status)] }));
  assert.equal(account.error, "sign in");
});
test("amp: rate limit honors Retry-After", async () => {
  await assert.rejects(amp.fetch(fakeContext({ ...configured, responses: [json({}, 429, { "retry-after": "120" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 120);
});
for (const response of [new Response("not json"), json({}), json({ secret: "never echo" }, 500)]) {
  test(`amp: invalid response ${response.status} is a sanitized HttpError`, async () => {
    await assert.rejects(amp.fetch(fakeContext({ ...configured, responses: [response] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("never echo"));
  });
}

test("Amp: CLI dollars and legacy subscription", async () => {
  const context = fakeContext({ commands: { "amp usage": { code: 0, stderr: "", stdout:
    "Signed in as test@example.com\nAmp Free: $5 / $10 remaining (replenishes +$0.50 / hour)\nSubscription Pro: 75% other usage and 50% orb usage remaining - resets upon renewal in 2 days" } } });
  const [account] = await amp.fetch(context);
  assert.equal(account.account, "example");
  assert.deepEqual(account.windows.map(w => w.used_percent), [50, 25]);
});
test("Amp: Tier uses exact dollars and independent orb hours", async () => {
  const context = fakeContext({ commands: { "amp usage": { code: 0, stderr: "", stdout:
    "Amp Pro Tier: agent usage $75 of $100 remaining, orb usage 4h of 10h a1.small orb hours remaining, period 2026-11-01 to 2026-12-01 resets upon renewal in 18 days" } } });
  assert.deepEqual((await amp.fetch(context))[0].windows.map(w => w.used_percent), [25, 60]);
});
test("Amp: web free-tier hydration is parsed without evaluation", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { amp: { cookieHeader: "session=fake" } } }) },
    responses: [new Response('<script>freeTierUsage:{quota:10,used:3,hourlyReplenishment:0.5,windowHours:20}</script>')] });
  assert.equal((await amp.fetch(context))[0].windows[0].used_percent, 30);
});
test("Amp: API auth-required envelope asks to sign in", async () => {
  assert.equal((await amp.fetch(fakeContext({ ...configured, responses: [json({ ok: false, error: { code: "auth-required" } })] })))[0].error, "sign in");
});
test("Amp: credits-only output", async () => {
  const [account] = await amp.fetch(fakeContext({ ...configured, responses: [json({ ok: true, result: { displayText: "Individual credits: $12.40 remaining\nWorkspace Test: $30 remaining" } })] }));
  assert.deepEqual(account.windows.map(w => w.value), ["$12.40", "$30.00"]);
});
