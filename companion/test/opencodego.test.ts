import assert from "node:assert/strict";
import { test } from "node:test";
import { opencodego } from "../src/providers/opencodego.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// CodexBar-derived opencodego fixture with fake identity and future resets.
const fixture = { usage: { rolling: { usagePercent: 17, resetInSec: 5944 }, weekly: { usagePercent: 75, resetInSec: 278201 }, monthly: { usagePercent: 100, resetInSec: 880201 } } };
const configured = { env: { OPENCODE_API_KEY: "fake-key" } };

test("opencodego: parses CodexBar-derived fixture", async () => {
  const context = fakeContext({ ...configured, responses: [json(fixture)] });
  const [account] = await opencodego.fetch(context);
  assert.equal(account.provider, "opencodego");
  assert.equal(account.windows[0].used_percent, 17);
  assert.ok(account.windows.length <= 2);
  assert.ok(context.calls.every(call => call.url.startsWith("https://")));
});
test("opencodego: missing credentials", async () => {
  await assert.rejects(opencodego.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403]) test(`opencodego: ${status} asks to sign in`, async () => {
  const [account] = await opencodego.fetch(fakeContext({ ...configured, responses: [json({}, status)] }));
  assert.equal(account.error, "sign in");
});
test("opencodego: rate limit honors Retry-After", async () => {
  await assert.rejects(opencodego.fetch(fakeContext({ ...configured, responses: [json({}, 429, { "retry-after": "120" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 120);
});
for (const response of [new Response("not json"), json({}), json({ secret: "never echo" }, 500)]) {
  test(`opencodego: invalid response ${response.status} is a sanitized HttpError`, async () => {
    await assert.rejects(opencodego.fetch(fakeContext({ ...configured, responses: [response] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("never echo"));
  });
}

test("OpenCode Go: legacy CLI key", async () => {
  const context = fakeContext({ files: { "/home/test/.local/share/opencode/auth.json": JSON.stringify({ "opencode-go": { type: "api", key: "fake-cli-key" } }) }, responses: [json(fixture)] });
  assert.equal((await opencodego.fetch(context))[0].windows.length, 2);
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-cli-key");
});
test("OpenCode Go: v2 logout never borrows legacy credentials", async () => {
  const context = fakeContext({ sqlite: { "/home/test/.local/share/opencode/opencode.db::SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'": [{ name: "credential" }] },
    files: { "/home/test/.local/share/opencode/auth.json": JSON.stringify({ "opencode-go": { type: "api", key: "stale-fake-key" } }) } });
  await assert.rejects(opencodego.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});
test("OpenCode Go: browser workspace and Console meters", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { opencodego: { cookieHeader: "__Host-auth=fake" } } }) },
    responses: [json([{ id: "org_fake" }]), json({ access: { meters: { fiveHour: { usedMicroCents: "25", limitMicroCents: "100", resetsAt: "2027-01-01T00:00:00Z" }, week: { usedMicroCents: "50", limitMicroCents: "100" } } } })] });
  const [account] = await opencodego.fetch(context);
  assert.deepEqual(account.windows.map(w => w.used_percent), [25, 50]);
  assert.equal(context.calls[1].headers["x-org-id"], "org_fake");
});
test("OpenCode Go: prepaid balance-only Console response", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { opencodego: { cookieHeader: "__Host-auth=fake", workspaceID: "org_fake" } } }) },
    responses: [json(null), json({ billingMode: "prepaid", mode: "pay-as-you-go", balanceMicroCents: "1240000000" })] });
  assert.equal((await opencodego.fetch(context))[0].windows[0].value, "$12.40");
});
test("OpenCode Go: legacy hydration fallback without executing JavaScript", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { opencodego: { cookieHeader: "auth=fake", workspaceID: "wrk_fake" } } }) },
    responses: [json({}, 404), new Response('$R[0]={rollingUsage:$R[1]={status:"ok",resetInSec:5944,usagePercent:17},weeklyUsage:$R[2]={status:"ok",resetInSec:278201,usagePercent:75}}')] });
  assert.deepEqual((await opencodego.fetch(context))[0].windows.map(w => w.used_percent), [17, 75]);
});
test("OpenCode Go: local SQLite costs deduplicate migration and prefer parts", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE message(id TEXT, data TEXT, time_created INTEGER); CREATE TABLE part(message_id TEXT, data TEXT, time_created INTEGER); CREATE TABLE session_message(id TEXT, type TEXT, data TEXT, time_created INTEGER)");
    const msg = { role: "assistant", providerID: "opencode-go", cost: 9, time: { created: (NOW - 60) * 1000 } };
    db.prepare("INSERT INTO message VALUES (?, ?, ?)").run("m1", JSON.stringify(msg), (NOW - 60) * 1000);
    db.prepare("INSERT INTO part VALUES (?, ?, ?)").run("m1", JSON.stringify({ type: "step-finish", cost: 2 }), (NOW - 60) * 1000);
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)").run("m1", "assistant", JSON.stringify({ model: { providerID: "opencode-go" }, cost: 2 }), (NOW - 60) * 1000);
    db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?)").run("m2", "assistant", JSON.stringify({ model: { providerID: "opencode-go" }, cost: 3 }), (NOW - 60) * 1000);
    const context = fakeContext({});
    context.querySqlite = async (_path, sql, params) => db.prepare(sql).all(...(params ?? []).map(p => p instanceof Uint8Array ? Buffer.from(p) : p));
    const [account] = await opencodego.fetch(context);
    assert.deepEqual(account.windows.map(w => [w.name, w.value]), [["local5h", "$5.00"], ["local7d", "$5.00"]]);
    assert.equal(account.blocked, false);
  } finally { db.close(); }
});
