import assert from "node:assert/strict";
import { test } from "node:test";
import { antigravity } from "../src/providers/antigravity.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// CodexBar-derived antigravity fixture with fake identity and future resets.
const fixture = { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.75, resetTime: "2027-01-01T00:00:00Z" }, { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.95, resetTime: "2027-01-01T00:00:00Z" }] }] };
const configured = { env: { ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({ accessToken: "fake-token", email: "test@example.com", projectID: "fake-project" }) } };

test("antigravity: parses CodexBar-derived fixture", async () => {
  const context = fakeContext({ ...configured, responses: [json({ cloudaicompanionProject: "fake-project" }), json(fixture)] });
  const [account] = await antigravity.fetch(context);
  assert.equal(account.provider, "antigravity");
  assert.equal(account.windows[0].used_percent, 5);
  assert.ok(account.windows.length <= 2);
  assert.ok(context.calls.every(call => call.url.startsWith("https://")));
});
test("antigravity: missing credentials", async () => {
  await assert.rejects(antigravity.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403]) test(`antigravity: ${status} asks to sign in`, async () => {
  const [account] = await antigravity.fetch(fakeContext({ ...configured, responses: [json({}, status)] }));
  assert.equal(account.error, "sign in");
});
test("antigravity: rate limit honors Retry-After", async () => {
  await assert.rejects(antigravity.fetch(fakeContext({ ...configured, responses: [json({}, 429, { "retry-after": "120" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 120);
});
for (const response of [new Response("not json"), json({}), json({ secret: "never echo" }, 500)]) {
  test(`antigravity: invalid response ${response.status} is a sanitized HttpError`, async () => {
    await assert.rejects(antigravity.fetch(fakeContext({ ...configured, responses: [response, json({}), json({})] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("never echo"));
  });
}

test("Antigravity: noninteractive CLI snake_case report", async () => {
  const context = fakeContext({ env: { ANTIGRAVITY_CLI_PATH: "/fake/agy" }, commands: { "/fake/agy --version": { code: 0, stdout: "agy 1.2.11", stderr: "" }, "/fake/agy -p /usage --output-format json --print-timeout 90s": { code: 0, stderr: "", stdout: JSON.stringify({ status: "SUCCESS", command: { name: "usage", data: { groups: [{ display_name: "Gemini", buckets: [
    { bucket_id: "gemini-5h", window: "5h", remaining_fraction: 0.8 }, { bucket_id: "gemini-weekly", window: "weekly", remaining_fraction: 0.5 },
  ] }] } } }) } } });
  assert.deepEqual((await antigravity.fetch(context))[0].windows.map(w => w.used_percent), [20, 50]);
});
test("Antigravity: model fallback separates Gemini and Claude pools", async () => {
  const context = fakeContext({ ...configured, responses: [json({ cloudaicompanionProject: "fake" }), json({}), json({ models: {
    "gemini-pro": { quotaInfo: { remainingFraction: 0.8 } }, "claude-sonnet": { quotaInfo: { remainingFraction: 0.5 } },
  } })] });
  assert.deepEqual((await antigravity.fetch(context))[0].windows.map(w => w.used_percent), [20, 50]);
});
test("Antigravity: expired OAuth without refresh client asks to sign in", async () => {
  const context = fakeContext({ env: { ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({ accessToken: "fake", expiryDateMilliseconds: NOW * 1000 }) } });
  assert.equal((await antigravity.fetch(context))[0].error, "sign in");
  assert.equal(context.calls.length, 0);
});
test("Antigravity: Google nonrotating refresh remains in memory", async () => {
  const context = fakeContext({ env: { ANTIGRAVITY_OAUTH_CREDENTIALS_JSON: JSON.stringify({ accessToken: "fake-old", refreshToken: "fake-refresh", clientID: "fake-client", clientSecret: "fake-secret", expiryDateMilliseconds: NOW * 1000 }) },
    responses: [json({ access_token: "fake-new" }), json({ cloudaicompanionProject: "fake" }), json(fixture)] });
  assert.equal((await antigravity.fetch(context))[0].windows[0].used_percent, 5);
  assert.equal(context.calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(context.calls[1].headers.authorization, "Bearer fake-new");
});

test("Antigravity: print mode never runs on older CLI versions", async () => {
  const context = fakeContext({ env: { ANTIGRAVITY_CLI_PATH: "/fake/agy" }, commands: { "/fake/agy --version": { code: 0, stdout: "agy 1.1.10", stderr: "" } } });
  await assert.rejects(antigravity.fetch(context), NotConfigured);
  assert.deepEqual(context.runs, ["/fake/agy --version"]);
});
test("Antigravity: explicit invalid CLI override never selects another installation", async () => {
  const context = fakeContext({ env: { ANTIGRAVITY_CLI_PATH: "" }, dirs: { "/opt/homebrew/bin": ["agy"] } });
  await assert.rejects(antigravity.fetch(context), NotConfigured);
  assert.deepEqual(context.runs, []);
});
