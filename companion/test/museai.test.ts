import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { museai } from "../src/providers/museai.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const credentials = { "files": { "/home/test/.config/busybar-usage/config.json": "{\"providers\": {\"museai\": {\"cookieHeader\": \"hatch_sess=fake\"}}}" } };
// Based on CodexBar's museai plugin fixtures, with reset times moved after the test clock.
const happy = () => [new Response('<script src="/_next/static/chunks/app.js"></script><script src="/_next/static/chunks/loader.js"></script>'),
new Response('e.A(434304).then(({preloadHatchSettingsData:e})=>e({}))'),
new Response('},434304,s=>{s.v(t=>Promise.all(["static/chunks/settings.js"].map(t=>s.l(t))))}'),
new Response('(0,d.createServerReference)("40447f7d32b58c622904d92f8ac01a13f4798568bd",d.callServer,void 0,d.findSourceMapURL,"fetchSubscriptionAction")'),
new Response('1:' + JSON.stringify({ success: true, subscription: { usage: { percentUsed: 3, resetsAt: NOW + 86400 }, topupBalance: 60000000, topupTotal: 80000000 } }))];

test("museai: CodexBar fixture", async () => {
  const ctx = fakeContext({ ...credentials, responses: happy() });
  const [account] = await museai.fetch(ctx);
  assert.equal(account.error, undefined);
  assert.deepEqual(account.windows.map(w => w.minutes), [10080, null]); assert.equal(account.windows[0].used_percent, 3); assert.equal(account.windows[1].value, "$60.00"); assert.equal(ctx.calls[1].headers.cookie, undefined);
});

test("museai: missing credentials", async () => {
  await assert.rejects(museai.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`museai: ${status} requires sign in`, async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({ private: "must not leak" }, status)] });
  const [account] = await museai.fetch(ctx);
  assert.equal(account.error, "sign in");
  assert.deepEqual(account.windows, []);
});

test("museai: rate limit", async () => {
  const ctx = fakeContext({ ...credentials, responses: [json({}, 429, { "retry-after": "17" })] });
  await assert.rejects(museai.fetch(ctx), (e: unknown) => e instanceof RateLimited && e.until === NOW + 17);
});

test("museai: invalid body is sanitized", async () => {
  const ctx = fakeContext({ ...credentials, responses: [new Response("private malformed body")] });
  await assert.rejects(museai.fetch(ctx), (e: unknown) => e instanceof HttpError && !e.message.includes("private"));
});

test("museai: free tier and unparseable Flight rows", async () => {
  const free = happy();
  free[4] = new Response('1:{"success":true,"subscription":{"usage":{"percentUsed":28,"resetsAt":' + (NOW + 86400) + '}}}');
  assert.equal((await museai.fetch(fakeContext({ ...credentials, responses: free })))[0].windows.length, 1);
  const invalid = happy();
  invalid[4] = new Response('1:{"success":true,"subscription":{"usage":{}}}');
  await assert.rejects(museai.fetch(fakeContext({ ...credentials, responses: invalid })), HttpError);
});

test("museai: cookie source off prevents requests even with a saved header", async () => {
  const files = { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { museai: { cookieSource: "off", cookieHeader: "fake" } } }) };
  const ctx = fakeContext({ files });
  await assert.rejects(museai.fetch(ctx), NotConfigured);
  assert.equal(ctx.calls.length, 0);
});
