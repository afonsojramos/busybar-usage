import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { alibabatokenplan } from "../src/providers/alibabatokenplan.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { alibabatokenplan: { cookieHeader: "session=fake; sec_token=fake-sec" } } }) };
// Based on AlibabaTokenPlanProviderTests' flat credit summary.
const summary = { Success: true, Data: { TotalCount: 1, TotalValue: 2000, TotalSurplusValue: 1500 } };
const personalFiles = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { alibabatokenplan: { region: "cn-personal", cookieHeader: "session=fake; sec_token=fake-sec" } } }) };
const usage = { code: "200", data: { DataV2: { data: { success: true, data: { per5HourPercentage: 0.25, per5HourResetTime: (NOW + 300) * 1000, per1WeekPercentage: 0.5, per1MonthPercentage: 0.75 } } } }, successResponse: true };
test("Alibaba Token Plan flat team summary", async () => {
  const c = fakeContext({ files, responses: [new Response('SEC_TOKEN: "fake-sec"'), json(summary)] });
  const [a] = await alibabatokenplan.fetch(c);
  assert.equal(a.windows[0].used_percent, 25);
  assert.equal(a.windows[0].name, "30d");
  assert.match(c.calls[1].url, /GetSubscriptionSummary/);
  assert.ok(c.runs[0].startsWith("bl token-plan list-seats"));
});
test("Alibaba Token Plan missing credentials", async () => { await assert.rejects(alibabatokenplan.fetch(fakeContext({})), NotConfigured); });
test("Alibaba Token Plan 401", async () => { assert.equal((await alibabatokenplan.fetch(fakeContext({ files, responses: [json({}, 401)] })))[0].error, "sign in"); });
test("Alibaba Token Plan 429", async () => { await assert.rejects(alibabatokenplan.fetch(fakeContext({ files, responses: [json({}, 429)] })), RateLimited); });
test("Alibaba Token Plan malformed summary", async () => { await assert.rejects(alibabatokenplan.fetch(fakeContext({ files, responses: [new Response('SEC_TOKEN: "fake-sec"'), json({})] })), HttpError); });
test("Alibaba Token Plan personal rolling windows", async () => {
  const c = fakeContext({ files: personalFiles, responses: [new Response('SEC_TOKEN: "fake-sec"'), json(usage)] });
  assert.deepEqual((await alibabatokenplan.fetch(c))[0].windows.map((w) => [w.name, w.used_percent]), [["5h", 25], ["7d", 50]]);
  assert.match(c.calls[1].url, /bailian-cs.console.aliyun.com/);
});
test("Alibaba Token Plan personal CLI", async () => {
  const command = "bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage --data {} --console-region cn-beijing --console-site domestic --output json";
  const c = fakeContext({ files: personalFiles, commands: { [command]: { code: 0, stdout: JSON.stringify(usage), stderr: "" } } });
  assert.equal((await alibabatokenplan.fetch(c))[0].windows[0].used_percent, 25);
  assert.equal(c.calls.length, 0);
});
test("Alibaba Token Plan team CLI current seats", async () => {
  const command = "bl token-plan list-seats --page-no 1 --page-size 10 --output json";
  const seat = { SeatId: "fake-seat", Status: "NORMAL", StartTime: (NOW - 1000) * 1000, EndTime: (NOW + 1000) * 1000, EquityList: [{ EquityType: "CREDITS", CycleStartTime: (NOW - 1000) * 1000, CycleEndTime: (NOW + 1000) * 1000, CycleTotalValue: 100, CycleSurplusValue: 0 }] };
  const c = fakeContext({ commands: { [command]: { code: 0, stdout: JSON.stringify({ Success: true, Data: { Total: 1, PageNo: 1, PageSize: 10, Items: [seat] } }), stderr: "" } } });
  const [a] = await alibabatokenplan.fetch(c);
  assert.equal(a.windows[0].used_percent, 100);
  assert.equal(a.blocked, true);
});
test("Alibaba Token Plan empty subscription remains visible", async () => {
  assert.deepEqual((await alibabatokenplan.fetch(fakeContext({ files, responses: [new Response('SEC_TOKEN: "fake-sec"'), json({ Success: true, Data: { TotalCount: 0 } })] })))[0].windows, []);
});

test("Alibaba Token Plan manual empty cookie never imports a browser account", async () => {
  for (const cookieHeader of [undefined, "", "   "]) {
    const c = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { alibabatokenplan: { cookieSource: "manual", cookieHeader } } }) } });
    c.querySqlite = async () => { throw new Error("browser cookie import must not run"); };
    c.listDir = async () => { throw new Error("browser profile discovery must not run"); };
    await assert.rejects(alibabatokenplan.fetch(c), NotConfigured);
    assert.equal(c.calls.length, 0);
  }
});
test("Alibaba Token Plan manual empty cookie preserves authenticated CLI", async () => {
  const command = "bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage --data {} --console-region cn-beijing --console-site domestic --output json";
  const c = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { alibabatokenplan: { region: "cn-personal", cookieSource: "manual", cookieHeader: "" } } }) }, commands: { [command]: { code: 0, stdout: JSON.stringify(usage), stderr: "" } } });
  c.querySqlite = async () => { throw new Error("browser cookie import must not run"); };
  assert.equal((await alibabatokenplan.fetch(c))[0].windows[0].used_percent, 25);
  assert.equal(c.calls.length, 0);
});
test("Alibaba Token Plan optional dashboard failure preserves cookie-only quota", async () => {
  for (const status of [404, 503]) {
    for (const personal of [false, true]) {
      const c = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { alibabatokenplan: { region: personal ? "cn-personal" : "cn", cookieHeader: "session=fake" } } }) }, responses: [json({}, status), json(personal ? usage : summary)] });
      const [a] = await alibabatokenplan.fetch(c);
      assert.equal(a.windows[0].used_percent, 25);
      assert.equal(c.calls.length, 2);
      assert.equal(c.calls[1].headers.cookie, "session=fake");
    }
  }
});
