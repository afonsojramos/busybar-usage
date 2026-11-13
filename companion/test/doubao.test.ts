import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { doubao } from "../src/providers/doubao.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's doubao provider test responses.
const payloads = [{ usage: { total_tokens: 1 } }];
const env = ({ ARK_API_KEY: 'fixture-key' });

test("doubao: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await doubao.fetch(context);
  assert.equal(account.provider, "doubao");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fixture-key");
});

test("doubao: missing credential", async () => {
  await assert.rejects(doubao.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`doubao: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status)] });
    const [account] = await doubao.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("doubao: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    doubao.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("doubao: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({ env, responses: [new Response("fixture-secret-invalid")] });
  await assert.rejects(
    doubao.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("doubao: signed Coding Plan API matches CodexBar headers", async () => {
  const context = fakeContext({
    env: { VOLCENGINE_ACCESS_KEY_ID: "AKLTTEST", VOLCENGINE_SECRET_ACCESS_KEY: "secret" },
    responses: [
      json({
        Result: {
          Status: "Running",
          QuotaUsage: [
            { Level: "session", Percent: 12.5, ResetTimestamp: NOW + 3600 },
            { Level: "weekly", Percent: 24 },
            { Level: "monthly", Percent: 30 },
          ],
        },
      }),
      json({ Result: {} }),
    ],
  });
  context.now = () => 1_781_654_400;
  const [account] = await doubao.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [13, 24],
  );
  assert.equal(context.calls[0].url, "https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01");
  assert.equal(context.calls[0].headers["x-date"], "20260617T000000Z");
  assert.equal(
    context.calls[0].headers["x-content-sha256"],
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.match(
    context.calls[0].headers.authorization,
    /^HMAC-SHA256 Credential=AKLTTEST\/20260617\/cn-beijing\/ark\/request, SignedHeaders=content-type;host;x-content-sha256;x-date, Signature=[a-f0-9]{64}$/,
  );
  assert.match(context.calls[1].url, /Action=GetAFPUsage/);
});
test("doubao: Agent Plan fallback uses millisecond resets", async () => {
  const [account] = await doubao.fetch(
    fakeContext({
      env: { VOLC_ACCESSKEY: "access", VOLC_SECRETKEY: "secret" },
      responses: [
        json({ Result: { Status: "Inactive" } }),
        json({
          Result: {
            AFPFiveHour: { Quota: 100, Used: 20, ResetTime: (NOW + 3600) * 1000 },
            AFPWeekly: { Quota: 1000, Used: 300 },
          },
        }),
      ],
    }),
  );
  assert.equal(account.windows[0].used_percent, 20);
  assert.equal(account.windows[0].resets_at, NOW + 3600);
});
test("doubao: configured AKLT key and secretKey select signed API", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { doubao: { apiKey: "AKLTTEST", secretKey: "secret", region: "cn-shanghai" } },
      }),
    },
    responses: [json({ Result: { QuotaUsage: [] } }), json({ Result: {} })],
  });
  await doubao.fetch(context);
  assert.match(context.calls[0].headers.authorization, /cn-shanghai\/ark\/request/);
});
test("doubao: configured Ark key does not inherit ambient AK/SK", async () => {
  const context = fakeContext({
    env: { VOLC_ACCESSKEY: "other-account", VOLC_SECRETKEY: "other-secret" },
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { doubao: { apiKey: "ark-key" } } }),
    },
    responses: [json({ usage: {} })],
  });
  await doubao.fetch(context);
  assert.equal(context.calls[0].headers.authorization, "Bearer ark-key");
});
test("doubao: arkcli source prioritizes Coding Plan and supports epoch resets", async () => {
  const context = fakeContext({
    commands: {
      "arkcli usage plan --format json": {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          viewer: { auth_method: "sso" },
          items: [
            { product: "agent-plan", periods: [{ label: "5h", percent: 80 }] },
            {
              product: "coding-plan",
              periods: [
                { label: "session", percent: 7.48, reset_at: (NOW + 3600) * 1000 },
                { label: "weekly", percent: 2.71 },
              ],
            },
          ],
        }),
      },
    },
  });
  const [account] = await doubao.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => w.used_percent),
    [7, 3],
  );
  assert.equal(account.windows[0].resets_at, NOW + 3600);
  assert.deepEqual(context.runs, ["arkcli usage plan --format json"]);
  assert.equal(context.calls.length, 0);
});
test("doubao: arkcli expired session and incomplete product", async () => {
  const context = fakeContext({
    commands: { "arkcli usage plan --format json": { code: 1, stdout: "", stderr: "please login" } },
  });
  assert.equal((await doubao.fetch(context))[0].error, "sign in");
  const incomplete = fakeContext({
    commands: {
      "arkcli usage plan --format json": {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({ items: [{ product: "coding-plan", subscribed: true }] }),
      },
    },
  });
  await assert.rejects(doubao.fetch(incomplete), HttpError);
});
test("doubao: API-key rate-limit headers retain an unknown period", async () => {
  const context = fakeContext({
    env,
    responses: [
      json({ usage: { total_tokens: 1 } }, 200, {
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "25",
        "x-ratelimit-reset-requests": "1h2m",
      }),
    ],
  });
  const [account] = await doubao.fetch(context);
  assert.equal(account.windows[0].used_percent, 75);
  assert.equal(account.windows[0].minutes, null);
  assert.equal(account.windows[0].resets_at, NOW + 3720);
});

test("doubao: two HTTP 200 zero-remaining probes are unreliable", async () => {
  const response = () =>
    json({ usage: {} }, 200, { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "0" });
  const context = fakeContext({ env, responses: [response(), response()] });
  const [account] = await doubao.fetch(context);
  assert.equal(account.blocked, false);
  assert.deepEqual(account.windows, []);
  assert.equal(context.calls.length, 2);
});
