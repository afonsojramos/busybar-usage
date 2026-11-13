import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { azureopenai } from "../src/providers/azureopenai.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's azureopenai provider test responses.
const payloads = [{ id: "cmpl-1", model: "gpt-4o-mini" }];
const env = ({
	AZURE_OPENAI_API_KEY: 'fixture-key',
	AZURE_OPENAI_ENDPOINT: 'https://resource.openai.azure.com',
	AZURE_OPENAI_DEPLOYMENT_NAME: 'chat-prod'
});

test("azureopenai: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await azureopenai.fetch(context);
  assert.equal(account.provider, "azureopenai");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["api-key"], "fixture-key");
});

test("azureopenai: missing credential", async () => {
  await assert.rejects(azureopenai.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`azureopenai: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status)] });
    const [account] = await azureopenai.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("azureopenai: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    azureopenai.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("azureopenai: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({ env, responses: [new Response("fixture-secret-invalid")] });
  await assert.rejects(
    azureopenai.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("azureopenai: v1 config overrides environment and uses the deployment model", async () => {
  const context = fakeContext({
    env: {
      ...env,
      AZURE_OPENAI_API_VERSION: "old",
      AZURE_OPENAI_ENDPOINT: "https://resource.openai.azure.com/base/openai/v1",
    },
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { azureopenai: { azureOpenAIAPIVersion: "v1" } },
      }),
    },
  });
  context.fetch = async (url, init) => {
    assert.equal(String(url), "https://resource.openai.azure.com/base/openai/v1/chat/completions");
    const body: unknown = JSON.parse(String(init?.body));
    assert.deepEqual(body, {
      messages: [{ role: "user", content: "ping" }],
      model: "chat-prod",
      max_completion_tokens: 64,
    });
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    return json({ model: "gpt-4o-mini" });
  };
  const [account] = await azureopenai.fetch(context);
  assert.equal(account.error, "no quota");
});
test("azureopenai: dated path preserves prefixes and escapes deployment", async () => {
  const context = fakeContext({
    env: {
      ...env,
      AZURE_OPENAI_ENDPOINT: "resource.openai.azure.com/base/openai",
      AZURE_OPENAI_DEPLOYMENT_NAME: "chat prod",
    },
    responses: [json({ model: "gpt-4o-mini" })],
  });
  await azureopenai.fetch(context);
  assert.equal(
    context.calls[0].url,
    "https://resource.openai.azure.com/base/openai/deployments/chat%20prod/chat/completions?api-version=2024-10-21",
  );
});
for (const endpoint of ["http://public.example", "https://user:password@resource.openai.azure.com", "invalid host"])
  test("azureopenai: unsafe endpoint sends no key", async () => {
    const context = fakeContext({ env: { ...env, AZURE_OPENAI_ENDPOINT: endpoint } });
    await assert.rejects(azureopenai.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  });
