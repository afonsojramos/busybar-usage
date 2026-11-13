import assert from "node:assert/strict";
import { test } from "node:test";
import { helmcode } from "../src/providers/helmcode.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const files = (region = "helmcode") => ({ "/home/test/.config/busybar-usage/config.json": JSON.stringify({
  providers: { helmcode: { cookieSource: "manual", cookieHeader: "session=fake", region } },
}) });
const quota = { periodStart: "2026-11-01", models: [
  { model: "helm-monthly", cap: 2_000_000_000, tokensUsed: 73_854_494, periodEnd: "2026-12-01T00:00:00Z" },
  { model: "helm-rolling-a", cap: 3_000_000_000, tokensUsed: 0, windowHours: 4, periodEnd: "2026-12-01T00:00:00Z" },
] };
test("Helmcode maps CodexBar fixture with premium gating and credits", async () => {
  const context = fakeContext({ files: files(), responses: [json(quota), json({ subscription: { premium: false } }),
    json({ balanceMicros: 12_500_000, currency: "eur" })] });
  const [account] = await helmcode.fetch(context);
  assert.equal(account?.windows[0]?.used_percent, 4);
  assert.equal(account?.windows[0]?.name, "30d");
  assert.equal(account?.windows[1]?.value, "€12.50");
  assert.equal(context.calls[0]?.headers.origin, "https://cloud.helmcode.com");
});
test("Helmcode keeps highest utilization models, shortest first", async () => {
  const data = { ...quota, models: [...quota.models, { model: "unlimited", cap: 0, tokensUsed: 0 }] };
  const context = fakeContext({ files: files(), responses: [json(data), json({ subscription: { premium: true } }), json({})] });
  assert.deepEqual((await helmcode.fetch(context))[0]?.windows.map((lane) => lane.minutes), [240, 43200]);
});
test("Helmcode unavailable optional billing hides rolling quota", async () => {
  const context = fakeContext({ files: files(), responses: [json(quota), json({}, 500), json({}, 500)] });
  assert.equal((await helmcode.fetch(context))[0]?.windows.length, 1);
});
test("Helmcode NaN manual credentials never reach Cloud or credits endpoint", async () => {
  const context = fakeContext({ files: files("nanBuilders"), responses: [json(quota), json({})] });
  await helmcode.fetch(context);
  assert.deepEqual(context.calls.map((call) => call.url), ["https://cloud-api.nan.builders/api/usage/quota", "https://cloud-api.nan.builders/api/billing"]);
});
test("Helmcode missing session", async () => { await assert.rejects(helmcode.fetch(fakeContext({})), NotConfigured); });
for (const status of [401, 403]) test(`Helmcode ${status} signs in`, async () => {
  const context = fakeContext({ files: files(), responses: [json({}, status)] });
  assert.equal((await helmcode.fetch(context))[0]?.error, "sign in");
  assert.equal(context.calls.length, 1);
});
test("Helmcode rate limits", async () => {
  await assert.rejects(helmcode.fetch(fakeContext({ files: files(), responses: [json({}, 429)] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300);
});
test("Helmcode malformed quotas fail visibly", async () => {
  for (const data of [{}, { ...quota, models: [{ model: "x", cap: -1, tokensUsed: 0 }] },
    { ...quota, models: [{ model: "x", cap: 1, tokensUsed: 0, windowHours: 0 }] }]) {
    await assert.rejects(helmcode.fetch(fakeContext({ files: files(), responses: [json(data), json({}), json({})] })), HttpError);
  }
});
test("Helmcode period fallback and exhaustion", async () => {
  const data = { periodStart: "2026-11-01", models: [{ model: "x", cap: 10, tokensUsed: 10 }] };
  const [account] = await helmcode.fetch(fakeContext({ files: files(), responses: [json(data), json({}), json({})] }));
  assert.equal(account?.blocked, true);
  assert.equal(account?.windows[0]?.resets_at, Date.parse("2026-12-01T00:00:00Z") / 1000);
});
