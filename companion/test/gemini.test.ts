import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { gemini, parseUsage } from "../src/providers/gemini.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, jwt, NOW } from "./helpers.ts";
const credentials = (extra = {}) => JSON.stringify({ access_token: "fake-access", id_token: jwt({ email: "test@example.com" }), expiry_date: (NOW + 3600) * 1000, ...extra });
const files = { "/home/test/.gemini/oauth_creds.json": credentials() };
const assist = { cloudaicompanionProject: "fixture-project" };
// Derived from GeminiAPITestHelpers.sampleQuotaResponse, with future reset dates.
const quota = { buckets: [
  { modelId: "gemini-2.5-pro", remainingFraction: 0.6, resetTime: "2026-12-01T00:00:00Z" },
  { modelId: "gemini-2.5-flash", remainingFraction: 0.9, resetTime: "2026-12-01T00:00:00Z" },
  { modelId: "gemini-2.5-flash-lite", remainingFraction: 0.8, resetTime: "2026-12-01T00:00:00Z" },
] };
test("Gemini reads CLI credentials and project before daily quota", async () => {
  const context = fakeContext({ files, responses: [json(assist), json(quota)] });
  const fetch = context.fetch;
  context.fetch = async (url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    if (String(url).endsWith(":retrieveUserQuota")) assert.equal(init?.body, '{"project":"fixture-project"}');
    return fetch(url, init);
  };
  const [account] = await gemini.fetch(context);
  assert.equal(account.account, "example");
  assert.deepEqual(account.windows.map((w) => [w.name, w.minutes, w.used_percent]), [["Pro", 1440, 40], ["Flash", 1440, 10]]);
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-access");
});
test("Gemini missing credentials", async () => {
  await assert.rejects(gemini.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403, 429, 500]) {
  test(`Gemini HTTP ${status} at both endpoints`, async () => {
    for (const responses of [[json({}, status)], [json(assist), json({}, status)]]) {
      const context = fakeContext({ files, responses });
      if (status === 401 || status === 403) assert.equal((await gemini.fetch(context))[0].error, "sign in");
      else await assert.rejects(gemini.fetch(context), status === 429 ? RateLimited : HttpError);
    }
  });
}
test("Gemini rejects malformed quota", async () => {
  for (const response of [new Response("fake-secret"), json({}), json({ buckets: [] })]) {
    await assert.rejects(gemini.fetch(fakeContext({ files, responses: [json(assist), response] })), HttpError);
  }
});
test("Gemini selects lowest tier fractions with Lite fallback", () => {
  assert.deepEqual(parseUsage({ buckets: [...quota.buckets.slice(1), { modelId: "gemini-2.5-flash", remainingFraction: 0 }] }, NOW)?.map((w) => [w.name, w.used_percent]), [["Flash", 100], ["Lite", 20]]);
});
test("Gemini project lookup supports object IDs and resource-manager fallback", async () => {
  /** The body of the quota request the provider sends. */
  const quotaBody = async (context: ReturnType<typeof fakeContext>) => {
    let body: unknown;
    const fetch = context.fetch;
    context.fetch = async (url, init) => {
      if (String(url).endsWith(":retrieveUserQuota")) body = init?.body;
      return fetch(url, init);
    };
    await gemini.fetch(context);
    return body;
  };
  for (const project of [{ id: "fixture-project" }, { projectId: "fixture-project" }]) {
    const context = fakeContext({ files, responses: [json({ cloudaicompanionProject: project }), json(quota)] });
    assert.equal(await quotaBody(context), '{"project":"fixture-project"}');
  }
  const fallback = fakeContext({ files, responses: [json({}), json({ projects: [{ projectId: "labeled", labels: { "generative-language": "" } }] }), json(quota)] });
  assert.equal(await quotaBody(fallback), '{"project":"labeled"}');
});
test("Gemini refreshes in memory with environment or installed OAuth client", async () => {
  for (const env of [{ GEMINI_OAUTH_CLIENT_ID: "fake-client", GEMINI_OAUTH_CLIENT_SECRET: "fake-secret" }, { GEMINI_OAUTH2_JS_PATH: "/fixture/oauth2.js" }, { PATH: "/fixture/bin" }]) {
    const source = "const OAUTH_CLIENT_ID = 'fake-client'; const OAUTH_CLIENT_SECRET = 'fake-secret';";
    const context = fakeContext({ env, files: {
      "/home/test/.gemini/oauth_creds.json": credentials({ expiry_date: NOW * 1000, refresh_token: "fake+&refresh" }),
      "/fixture/oauth2.js": source,
      "/fixture/lib/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js": source,
    }, responses: [json({ access_token: "fake-new" }), json(assist), json(quota)] });
    const fetch = context.fetch;
    context.fetch = async (url, init) => {
      assert.ok(init?.signal instanceof AbortSignal);
      if (String(url).endsWith("/token")) assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), "fake+&refresh");
      return fetch(url, init);
    };
    await gemini.fetch(context);
    assert.equal(context.calls[1].headers.authorization, "Bearer fake-new");
  }
});
test("Gemini cannot refresh without a client", async () => {
  const context = fakeContext({ files: { "/home/test/.gemini/oauth_creds.json": credentials({ expiry_date: 1 }) } });
  assert.equal((await gemini.fetch(context))[0].error, "sign in");
  assert.equal(context.calls.length, 0);
});
test("Gemini refresh errors remain sanitized and rate limits retain Retry-After", async () => {
  for (const status of [401, 403, 429, 500, 200]) {
    const context = fakeContext({
      env: { GEMINI_OAUTH_CLIENT_ID: "fake-client", GEMINI_OAUTH_CLIENT_SECRET: "fake-secret" },
      files: { "/home/test/.gemini/oauth_creds.json": credentials({ expiry_date: 1, refresh_token: "fake-refresh" }) },
      responses: [json({ secret: "fake-secret" }, status, { "retry-after": "60" })],
    });
    if (status === 401 || status === 403) assert.equal((await gemini.fetch(context))[0].error, "sign in");
    else await assert.rejects(gemini.fetch(context), (e: unknown) => status === 429 ? e instanceof RateLimited && e.until === NOW + 60 : e instanceof HttpError && !e.message.includes("fake-secret"));
  }
});
test("Gemini blocks exhausted quotas and rejects unrecognized buckets", async () => {
  const context = fakeContext({ files, responses: [json(assist), json({ buckets: [{ modelId: "gemini-pro", remainingFraction: 0 }] })] });
  assert.equal((await gemini.fetch(context))[0].blocked, true);
  assert.equal(parseUsage({ buckets: [{ modelId: "unknown", remainingFraction: 0 }] }, NOW), null);
});
