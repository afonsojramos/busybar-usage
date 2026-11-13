import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { xai } from "../src/providers/xai.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { "XAI_MANAGEMENT_API_KEY": "fake-key", "XAI_TEAM_ID": "team-1234" };
const fixture = [{ "total": { "val": "-1000" } }, { "coreInvoice": { "amountAfterVat": "350" } }];

test("xai: CodexBar-derived usage fixture", async () => {
  const context = fakeContext({ env, responses: fixture.map(body => json(body)) });
  const [account] = await xai.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "xai");
  assert.deepEqual(account.windows.map(w => w.used_percent), [null, null]);
  assert.deepEqual(account.windows.map(w => w.value ?? null), ["$10.00", "$6.50"]);
  assert.equal(account.blocked, false);
  assert.ok(context.calls[0]?.url.startsWith("https://management-api.x.ai/v1/billing/teams/team-1234/prepaid/balance"));
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-key");
});

test("xai: missing credential", async () => {
  await assert.rejects(xai.fetch(fakeContext({})), NotConfigured);
});

for (const status of [401, 403]) test(`xai: ${status} requires sign in`, async () => {
  const [account] = await xai.fetch(fakeContext({ env, responses: [json({}, status)] }));
  assert.equal(account?.error, "sign in");
  assert.deepEqual(account?.windows, []);
});

test("xai: rate limit preserves Retry-After", async () => {
  await assert.rejects(xai.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    error => error instanceof RateLimited && error.until === NOW + 42);
  await assert.rejects(xai.fetch(fakeContext({ env, responses: [json({}, 429)] })),
    error => error instanceof RateLimited && error.until === NOW + 300);
});

test("xai: malformed bodies and HTTP failures do not expose bodies", async () => {
  for (const response of [json({}, 503), json({}), new Response("fake-private-body")]) {
    await assert.rejects(xai.fetch(fakeContext({ env, responses: [response] })),
      error => error instanceof HttpError && !error.message.includes("fake-private-body"));
  }
});

test("xai: optional preview failure falls back to bounded history", async () => {
  const context = fakeContext({ env, responses: [json(fixture[0]), json({}, 403), json({ timeSeries: [{ dataPoints: [{ timestamp: "2026-11-01T00:00:00Z", values: [1.25] }] }], limitReached: true })] });
  const [a] = await xai.fetch(context);
  assert.equal(a?.windows[1]?.name, "30d part");
  assert.equal(a?.windows[1]?.value, "$1.25");
  assert.equal(context.calls[2]?.url, "https://management-api.x.ai/v1/billing/teams/team-1234/usage");
});

test("xai: invalid team, malformed balance and rejected history", async () => {
  await assert.rejects(xai.fetch(fakeContext({ env: { ...env, XAI_TEAM_ID: "../team" } })), NotConfigured);
  await assert.rejects(xai.fetch(fakeContext({ env, responses: [json({ total: { val: "NaN" } })] })), HttpError);
  const [a] = await xai.fetch(fakeContext({ env, responses: [json(fixture[0]), json({}, 404), json({}, 401)] }));
  assert.equal(a?.error, "sign in");
});


test("xai: config key and request safety", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { xai: { apiKey: "fake-config", workspaceID: "team-1234" } } }) }, responses: fixture.map(b => json(b)) });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.redirect, "error");
    return fetch(input, init);
  };
  await xai.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-config");
});

test("xai: history analytics uses POST and UTC day query", async () => {
  const context = fakeContext({ env, responses: [json(fixture[0]), json(fixture[1]), json({ timeSeries: [] })] });
  const fetch = context.fetch;
  context.fetch = async (url, init) => {
    if (String(url).endsWith("/usage")) {
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      assert.equal(typeof init?.body, "string");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.analyticsRequest.timeRange.timezone, "Etc/GMT");
      assert.equal(body.analyticsRequest.timeUnit, "TIME_UNIT_DAY");
      assert.deepEqual(body.analyticsRequest.values, [{ name: "usd", aggregation: "AGGREGATION_SUM" }]);
    }
    return fetch(url, init);
  };
  await xai.fetch(context);
  assert.equal(context.calls.length, 3);
});
