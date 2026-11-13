import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { deepgram } from "../src/providers/deepgram.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's deepgram provider test responses.
const payloads = [
  {
    start: "2025-01-16",
    end: "2025-01-23",
    resolution: { units: "day", amount: 1 },
    results: [
      {
        hours: 1619.7242069444444,
        total_hours: 1621.7395791666668,
        agent_hours: 41.33564388888889,
        tokens_in: 1200,
        tokens_out: 340,
        tts_characters: 9158866,
        requests: 373381,
      },
      { hours: 2.25, total_hours: 3.5, requests: 19 },
    ],
  },
];
const env = ({
	DEEPGRAM_API_KEY: 'fixture-key',
	DEEPGRAM_PROJECT_ID: 'project-123'
});

test("deepgram: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await deepgram.fetch(context);
  assert.equal(account.provider, "deepgram");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.match(account.windows[0].value ?? "", new RegExp("1\\.6K"));
  assert.match(account.windows[1].value ?? "", new RegExp("373\\.4K"));
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["authorization"], "Token fixture-key");
});

test("deepgram: missing credential", async () => {
  await assert.rejects(deepgram.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`deepgram: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status)] });
    const [account] = await deepgram.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("deepgram: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    deepgram.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("deepgram: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({ env, responses: [new Response("fixture-secret-invalid")] });
  await assert.rejects(
    deepgram.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("deepgram: discovers projects and aggregates usage", async () => {
  const context = fakeContext({
    env: { DEEPGRAM_API_KEY: "key" },
    responses: [
      json({ projects: [{ project_id: "one", name: "One" }, { project_id: "two" }] }),
      json({ results: [{ hours: 1.5, requests: 7 }] }),
      json({ results: [{ hours: 2, requests: 3 }] }),
    ],
  });
  const [account] = await deepgram.fetch(context);
  assert.equal(account.windows[0].value, "3.5 h");
  assert.equal(account.windows[1].value, "10");
  assert.equal(context.calls[0].url, "https://api.deepgram.com/v1/projects");
});
for (const body of [
  {},
  { results: [{ hours: "1.5" }] },
  { results: [{ tokens_in: 1.5 }] },
  { results: [], resolution: { amount: "1" } },
])
  test("deepgram: rejects invalid breakdown", async () => {
    await assert.rejects(deepgram.fetch(fakeContext({ env, responses: [json(body)] })), HttpError);
  });
test("deepgram: config workspace selects project", async () => {
  const context = fakeContext({
    env: { DEEPGRAM_API_KEY: "key" },
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { deepgram: { workspaceID: "project/name" } },
      }),
    },
    responses: [json({ results: [] })],
  });
  await deepgram.fetch(context);
  assert.equal(context.calls[0].url, "https://api.deepgram.com/v1/projects/project%2Fname/usage/breakdown");
});
