import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { qwencloud } from "../src/providers/qwencloud.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const env = { QWEN_CLOUD_COOKIE: "session=fake; sec_token=fake-sec" };
const info = { data: { secToken: "fake-sec" } };
const human = { code: "200", successResponse: true, data: { Data: { SellerInfoDto: { Nbid: "fake-selector" } } } };
// Based on the qwencloud-team plugin's active credit_value subscription response.
const team = { code: "200", successResponse: true, data: { Data: { ProductCode: "sfm_tokenplanteams_dp_intl", StartTime: (NOW - 1000) * 1000, EndTime: (NOW + 1000) * 1000, SubscriptionGroupList: [{ EquityList: [{ EquityCode: "credit_value", TotalValue: "1000", SurplusValue: "750" }], NextCycleFlushTime: (NOW + 600) * 1000 }] } } };
const usage = { code: "200", data: { DataV2: { data: { success: true, data: { per5HourPercentage: 0.1, per5HourResetTime: (NOW + 300) * 1000, per1WeekPercentage: 0.5, per1MonthPercentage: 0.9 } } } }, successResponse: true };
test("Qwen Cloud Team credits take precedence", async () => {
  const c = fakeContext({ env, responses: [json(info), json(human), json(team)] });
  const [a] = await qwencloud.fetch(c);
  assert.equal(a.windows[0].used_percent, 25);
  assert.equal(a.windows[0].resets_at, NOW + 600);
  assert.equal(a.windows[0].name, "Team");
  assert.match(c.calls[2].url, /GetSeatSubscriptionSummary/);
  assert.equal(c.calls[2].headers.cookie, env.QWEN_CLOUD_COOKIE);
});
test("Qwen Cloud missing session", async () => { await assert.rejects(qwencloud.fetch(fakeContext({})), NotConfigured); });
test("Qwen Cloud 401", async () => { assert.equal((await qwencloud.fetch(fakeContext({ env, responses: [json({}, 401)] })))[0].error, "sign in"); });
test("Qwen Cloud 429", async () => { await assert.rejects(qwencloud.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "31" })] })), (e) => e instanceof RateLimited && e.until === NOW + 31); });
test("Qwen Cloud Individual fallback after no Team subscription", async () => {
  const c = fakeContext({ env, responses: [json(info), json(human), json({ code: "200", data: { Data: {} } }), new Response('SEC_TOKEN: "fake-sec"'), json(usage)] });
  assert.deepEqual((await qwencloud.fetch(c))[0].windows.map((w) => [w.name, w.used_percent]), [["5h", 10], ["7d", 50]]);
  assert.match(c.calls[4].url, /cs-data.qwencloud.com/);
});
test("Qwen Cloud Individual rejects malformed payload", async () => {
  const c = fakeContext({ env: { ...env, QWEN_CLOUD_HOST: "home.qwencloud.com" }, responses: [new Response('SEC_TOKEN: "fake-sec"'), json({})] });
  await assert.rejects(qwencloud.fetch(c), HttpError);
});
test("Qwen Cloud monthly-only quota remains a lane", async () => {
  const c = fakeContext({ env: { ...env, QWEN_CLOUD_HOST: "home.qwencloud.com" }, responses: [new Response('SEC_TOKEN: "fake-sec"'), json({ per1MonthPercentage: 1 })] });
  const [a] = await qwencloud.fetch(c);
  assert.equal(a.windows[0].name, "30d"); assert.equal(a.blocked, true);
});
test("Qwen Cloud rejects unrelated endpoint", async () => { await assert.rejects(qwencloud.fetch(fakeContext({ env: { ...env, QWEN_CLOUD_HOST: "https://attacker.example" } })), NotConfigured); });

test("Qwen Cloud manual empty cookie never imports a browser account", async () => {
  for (const cookieHeader of [undefined, "", "   "]) {
    const c = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { qwencloud: { cookieSource: "manual", cookieHeader } } }) } });
    c.querySqlite = async () => { throw new Error("browser cookie import must not run"); };
    c.listDir = async () => { throw new Error("browser profile discovery must not run"); };
    await assert.rejects(qwencloud.fetch(c), NotConfigured);
    assert.equal(c.calls.length, 0);
  }
});
