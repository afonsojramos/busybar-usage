import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { openai } from "../src/providers/openai.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's openai provider test responses.
const payloads = [
  {
    data: [
      {
        start_time: 1700000000,
        end_time: 1700086400,
        results: [{ amount: { value: 12.5, currency: "usd" } }, { amount: { value: "2.25", currency: "usd" } }],
      },
    ],
    has_more: false,
  },
  {
    data: [
      {
        start_time: 1700000000,
        end_time: 1700086400,
        results: [
          { input_tokens: 1000, input_cached_tokens: 250, output_tokens: 500, num_model_requests: 7, model: "gpt-5.2" },
        ],
      },
    ],
    has_more: false,
  },
];
const env = ({ OPENAI_ADMIN_KEY: 'fixture-key' });

test("openai: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await openai.fetch(context);
  assert.equal(account.provider, "openai");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.match(account.windows[0].value ?? "", new RegExp("14\\.75"));
  assert.match(account.windows[1].value ?? "", new RegExp("1\\.5K"));
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fixture-key");
});

test("openai: missing credential", async () => {
  await assert.rejects(openai.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`openai: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status), json({}, status)] });
    const [account] = await openai.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("openai: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    openai.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("openai: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({
    env,
    responses: [new Response("fixture-secret-invalid"), new Response("fixture-secret-invalid")],
  });
  await assert.rejects(
    openai.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("openai: legacy balance fallback and grant expiry", async () => {
  const context = fakeContext({
    env: { OPENAI_API_KEY: "legacy" },
    responses: [
      json({}, 403),
      json({
        total_granted: 100,
        total_used: 25,
        total_available: 75,
        grants: { data: [{ expires_at: NOW - 1 }, { expires_at: NOW + 3600 }] },
      }),
    ],
  });
  const [account] = await openai.fetch(context);
  assert.equal(account.windows[0].used_percent, 25);
  assert.equal(account.windows[0].resets_at, NOW + 3600);
  assert.equal(account.windows[1].value, "$75.00");
});
test("openai: project-scoped admin failures do not use unscoped billing", async () => {
  const context = fakeContext({
    env: { OPENAI_ADMIN_KEY: "admin", OPENAI_PROJECT_ID: "proj_1" },
    responses: [json({}, 403)],
  });
  const [account] = await openai.fetch(context);
  assert.equal(account.error, "sign in");
  assert.equal(context.calls.length, 1);
  assert.equal(new URL(context.calls[0].url).searchParams.get("project_ids"), "proj_1");
});
test("openai: pagination and history ranges stay within endpoint bucket limits", async () => {
  const context = fakeContext({
    env: { ...env, OPENAI_HISTORY_DAYS: "32", OPENAI_PROJECT_ID: "proj" },
    responses: [
      json({ data: [], has_more: true, next_page: "next" }),
      json({ data: [], has_more: false }),
      json({ data: [], has_more: false }),
      json({ data: [], has_more: false }),
      json({ data: [], has_more: false }),
    ],
  });
  await openai.fetch(context);
  assert.deepEqual(
    context.calls.map((call) => new URL(call.url).searchParams.get("limit")),
    ["31", "31", "1", "31", "1"],
  );
  assert.equal(new URL(context.calls[1].url).searchParams.get("page"), "next");
});
