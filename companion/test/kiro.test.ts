import assert from "node:assert/strict";
import { test } from "node:test";
import { kiro, parseKiroUsage } from "../src/providers/kiro.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const path = "/home/test/.local/share/kiro-cli/data.sqlite3";
const configured = { sqlite: {
  [`${path}::SELECT value FROM auth_kv WHERE key = 'kirocli:odic:token'`]: [{ value: JSON.stringify({ access_token: "fake-token" }) }],
  [`${path}::SELECT value FROM state WHERE key = 'api.codewhisperer.profile'`]: [],
} };
// CodexBar KiroUsageLimitsAPITests.overageInUseResponse, with a future reset.
const credit = { resourceType: "CREDIT", currentUsageWithPrecision: 13603.49, currentOveragesWithPrecision: 3603.49,
  usageLimitWithPrecision: 10000, overageCapWithPrecision: 10000, bonuses: [] };
const fixture = { nextDateReset: NOW + 86400, overageConfiguration: { overageStatus: "ENABLED" }, usageBreakdownList: [credit] };
test("Kiro: separates plan spend from overage", async () => {
  const context = fakeContext({ ...configured, responses: [json(fixture)], commands: { "kiro-cli whoami": { code: 0, stdout: "Email: test@example.com", stderr: "" } } });
  const [account] = await kiro.fetch(context);
  assert.equal(account.account, "example");
  assert.deepEqual(account.windows.map(w => w.used_percent), [100, 36]);
  assert.equal(account.blocked, true);
  assert.equal(context.calls[0].headers["x-amz-target"], "AmazonCodeWhispererService.GetUsageLimits");
});
test("Kiro: no CLI or credentials", async () => { await assert.rejects(kiro.fetch(fakeContext({})), NotConfigured); });
for (const status of [401, 403]) test(`Kiro: ${status} asks to sign in`, async () => {
  assert.equal((await kiro.fetch(fakeContext({ ...configured, responses: [json({}, status)] })))[0].error, "sign in");
});
test("Kiro: throttling", async () => {
  await assert.rejects(kiro.fetch(fakeContext({ ...configured, responses: [json({}, 429)] })),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 300);
});
test("Kiro: bad API body is HttpError", async () => {
  await assert.rejects(kiro.fetch(fakeContext({ ...configured, responses: [new Response("invalid")] })), HttpError);
});
test("Kiro: CLI fallback and bonus", async () => {
  const context = fakeContext({ commands: { "kiro-cli chat --no-interactive /usage --v2": { code: 0, stderr: "", stdout:
    "Estimated Usage | resets on 2027-01-01 | KIRO FREE\nCredits (12.5 of 50 covered in plan)\n25%\nBonus credits: 5/100 credits used, expires in 88 days" } } });
  const [account] = await kiro.fetch(context);
  assert.deepEqual(account.windows.map(w => w.used_percent), [25, 5]);
});
test("Kiro: rejects ambiguous bonus totals and impossible overages", () => {
  assert.equal(parseKiroUsage({ ...fixture, usageBreakdownList: [{ ...credit, bonuses: [{}] }] }, NOW), null);
  assert.equal(parseKiroUsage({ ...fixture, usageBreakdownList: [{ ...credit, currentOveragesWithPrecision: 20000 }] }, NOW), null);
  assert.equal(parseKiroUsage({ ...fixture, nextDateReset: 1.8e12 }, NOW), null);
});
test("Kiro: older CLI retries only an explicitly rejected v2 flag", async () => {
  const context = fakeContext({ commands: {
    "kiro-cli chat --no-interactive /usage --v2": { code: 1, stdout: "", stderr: "error: unexpected argument '--v2'" },
    "kiro-cli chat --no-interactive /usage": { code: 0, stdout: "Plan: KIRO PRO MAX | 1 usage breakdowns", stderr: "" },
  } });
  assert.deepEqual((await kiro.fetch(context))[0].windows, []);
  assert.ok(context.runs.includes("kiro-cli chat --no-interactive /usage"));
});
