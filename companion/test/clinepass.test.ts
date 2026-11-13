import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { clinepass } from "../src/providers/clinepass.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's clinepass provider test responses.
const payloads = [
  {
    success: true,
    data: {
      limits: [
        { type: "five_hour", percentUsed: 12.5 },
        { type: "weekly", percentUsed: 34 },
        { type: "monthly", percentUsed: 56.75 },
      ],
    },
  },
];
const env = { CLINE_API_KEY: "fixture-key" };

test("clinepass: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await clinepass.fetch(context);
  assert.equal(account.provider, "clinepass");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.equal(account.windows[0].used_percent, 13);
  assert.equal(account.windows[1].used_percent, 34);
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fixture-key");
});

test("clinepass: missing credential", async () => {
  await assert.rejects(clinepass.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`clinepass: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status)] });
    const [account] = await clinepass.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("clinepass: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    clinepass.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("clinepass: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({ env, responses: [new Response("fixture-secret-invalid")] });
  await assert.rejects(
    clinepass.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("clinepass: Cline OAuth file wins over retained keys", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.cline/data/settings/providers.json": JSON.stringify({
        providers: {
          cline: {
            settings: {
              auth: { accessToken: "fixture-session", apiKey: "unused-auth-key" },
              apiKey: "unused-key",
            },
          },
        },
      }),
    },
    responses: payloads.map((p) => json(p)),
  });
  await clinepass.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer workos:fixture-session");
});
for (const [variable, value, path] of [
  ["CLINE_PROVIDER_SETTINGS_PATH", "~/custom.json", "/home/test/custom.json"],
  ["CLINE_DATA_DIR", "/custom", "/custom/settings/providers.json"],
  ["CLINE_DIR", "/custom", "/custom/data/settings/providers.json"],
])
  test(`clinepass: path override ${variable}`, async () => {
    const context = fakeContext({
      env: { [variable]: value },
      files: { [path]: JSON.stringify({ providers: { cline: { settings: { apiKey: "file-key" } } } }) },
      responses: payloads.map((p) => json(p)),
    });
    await clinepass.fetch(context);
    assert.equal(context.calls[0].headers.authorization, "Bearer file-key");
  });
test("clinepass: API key wins over local OAuth", async () => {
  const context = fakeContext({
    env: { CLINE_API_KEY: "first", CLINEPASS_API_KEY: "second" },
    responses: payloads.map((p) => json(p)),
  });
  await clinepass.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer first");
});
for (const body of [
  { success: false },
  { success: true, data: { limits: [null] } },
  { success: true, data: { limits: [{ type: "weekly", percentUsed: "40" }] } },
  { success: true, data: { limits: [{ type: "weekly", percentUsed: 40, resetsAt: "invalid" }] } },
]) {
  test("clinepass: rejects malformed quota", async () => {
    await assert.rejects(clinepass.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  });
}
test("clinepass: unknown limits are ignored and past resets zero usage", async () => {
  const [account] = await clinepass.fetch(
    fakeContext({
      env,
      responses: [
        json({
          success: true,
          data: {
            limits: [
              { type: "unknown", percentUsed: "ignored" },
              { type: "weekly", percentUsed: 100, resetsAt: new Date((NOW - 1) * 1000).toISOString() },
            ],
          },
        }),
      ],
    }),
  );
  assert.equal(account.windows[0].used_percent, 0);
  assert.equal(account.blocked, false);
});
