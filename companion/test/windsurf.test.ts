import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { windsurf, parseCachedPlan, parsePlanStatus } from "../src/providers/windsurf.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const session = { devin_session_token: "fake-session", devin_auth1_token: "fake-auth1", devin_account_id: "account-123", devin_primary_org_id: "org-456" };
const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { windsurf: { cookieSource: "manual", cookieHeader: JSON.stringify(session) } } }) };
function varint(value: number): number[] { const bytes: number[] = []; do { const b = value % 128; value = Math.floor(value / 128); bytes.push(b | (value ? 128 : 0)); } while (value); return bytes; }
function field(number: number, value: number): number[] { return [...varint(number * 8), ...varint(value)]; }
function fixture(): Uint8Array {
  const status = [...field(14, 68), ...field(15, 84), ...field(17, NOW + 100), ...field(18, NOW + 700)];
  return Uint8Array.from([10, ...varint(status.length), ...status]);
}

test("Windsurf decodes CodexBar protobuf fixture and request", async () => {
  const context = fakeContext({ files });
  let body: Buffer | null = null;
  context.fetch = async (input, init) => {
    assert.equal(String(input), "https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/GetPlanStatus");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-devin-session-token"), "fake-session");
    assert.equal(headers.get("x-devin-auth1-token"), "fake-auth1");
    assert.equal(headers.get("Content-Type"), "application/proto");
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal);
    assert.ok(Buffer.isBuffer(init?.body));
    if (Buffer.isBuffer(init?.body)) body = init.body;
    return new Response(Buffer.from(fixture()));
  };
  const [account] = await windsurf.fetch(context);
  assert.deepEqual(account?.windows.map((w) => [w.minutes, w.used_percent]), [[1440, 32], [10080, 16]]);
  assert.deepEqual(body, Buffer.concat([Buffer.from([10, 12]), Buffer.from("fake-session"), Buffer.from([16, 1])]));
});

test("Windsurf has no credentials", async () => { await assert.rejects(windsurf.fetch(fakeContext({})), NotConfigured); });
for (const status of [401, 403]) test(`Windsurf ${status}`, async () => {
  assert.equal((await windsurf.fetch(fakeContext({ files, responses: [json({}, status)] })))[0]?.error, "sign in");
});
test("Windsurf 429", async () => {
  await assert.rejects(windsurf.fetch(fakeContext({ files, responses: [json({}, 429)] })), (e: unknown) => e instanceof RateLimited && e.until === NOW + 300);
});
test("Windsurf rejects malformed protobuf", async () => {
  for (const bytes of [[10, 5], [0], []]) await assert.rejects(windsurf.fetch(fakeContext({ files, responses: [new Response(Buffer.from(bytes))] })), HttpError);
});
test("Windsurf reads UTF16 SQLite cache and quota windows", async () => {
  const query = "SELECT value FROM ItemTable WHERE key = 'windsurf.settings.cachedPlanInfo' LIMIT 1;";
  const context = fakeContext({ sqlite: { [`/home/test/Library/Application Support/Windsurf/User/globalStorage/state.vscdb::${query}`]: [{ value: Buffer.from(JSON.stringify({ quotaUsage: { dailyRemainingPercent: 75, weeklyRemainingPercent: 0, dailyResetAtUnix: NOW + 300, weeklyResetAtUnix: NOW + 700 } }), "utf16le") }] } });
  const [account] = await windsurf.fetch(context);
  assert.deepEqual(account?.windows.map((w) => w.used_percent), [25, 100]);
  assert.equal(account?.blocked, true);
});
test("Windsurf local counters support remaining and mixed quota shapes", () => {
  assert.deepEqual(parseCachedPlan({ usage: { messages: 100, remainingMessages: 40, flowActions: 20, usedFlowActions: 5 } }, NOW)?.map((w) => [w.name, w.used_percent]), [["msgs", 60], ["flows", 25]]);
  assert.deepEqual(parseCachedPlan({ quotaUsage: { dailyRemainingPercent: 90 }, usage: { flowActions: 20, usedFlowActions: 5 } }, NOW)?.map((w) => w.used_percent), [10, 25]);
  assert.equal(parseCachedPlan({}, NOW), null);
  assert.equal(parsePlanStatus(Uint8Array.from([10, 0]), NOW), null);
});

test("Windsurf auto mode falls back to cached usage after web service failure", async () => {
  const query = "SELECT value FROM ItemTable WHERE key = 'windsurf.settings.cachedPlanInfo' LIMIT 1;";
  const context = fakeContext({ files, sqlite: { [`/home/test/Library/Application Support/Windsurf/User/globalStorage/state.vscdb::${query}`]: [{ value: JSON.stringify({ usage: { messages: 100, usedMessages: 25 } }) }] }, responses: [json({}, 503)] });
  assert.equal((await windsurf.fetch(context))[0]?.windows[0]?.used_percent, 25);
});
