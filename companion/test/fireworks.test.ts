import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { fireworks } from "../src/providers/fireworks.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Adapted from CodexBar's fireworks provider test responses.
const payloads = [{ lineItems: [{ totalCost: { units: "62", nanos: 990000000, currencyCode: "USD" } }] }];
const env = {
  FIREWORKS_API_KEY: "fixture-key",
  FIREWORKS_ACCOUNT_SLUG: "test-account",
};

test("fireworks: CodexBar fixture", async () => {
  const context = fakeContext({ env, responses: payloads.map((body) => json(body)) });
  const [account] = await fireworks.fetch(context);
  assert.equal(account.provider, "fireworks");
  assert.equal(account.account, "default");
  assert.equal(account.observed_at, new Date(NOW * 1000).toISOString());
  assert.ok(account.windows.length <= 2);
  assert.match(account.windows[0].value ?? "", new RegExp("62\\.99"));
  assert.equal(context.calls[0].headers.accept, "application/json");
  assert.equal(context.calls[0].headers["authorization"], "Bearer fixture-key");
});

test("fireworks: missing credential", async () => {
  await assert.rejects(fireworks.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`fireworks: HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status)] });
    const [account] = await fireworks.fetch(context);
    assert.equal(account.error, "sign in");
  });
test("fireworks: rate limited", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] });
  await assert.rejects(
    fireworks.fetch(context),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("fireworks: invalid JSON is a safe HTTP error", async () => {
  const context = fakeContext({ env, responses: [new Response("fixture-secret-invalid")] });
  await assert.rejects(
    fireworks.fetch(context),
    (error: unknown) => error instanceof HttpError && !error.message.includes("fixture-secret"),
  );
});

test("fireworks: discovers paginated accounts and sums rated costs", async () => {
  const context = fakeContext({
    env: { FIREWORKS_KEY: "alias-key" },
    responses: [
      json({ accounts: [{ name: "accounts/only" }], nextPageToken: "next" }),
      json({ accounts: [{ accountId: "only" }] }),
      ...payloads.map((p) => json(p)),
    ],
  });
  const [account] = await fireworks.fetch(context);
  assert.equal(account.windows[0].value, "$62.99");
  assert.equal(context.calls[1].url, "https://api.fireworks.ai/v1/accounts?pageToken=next");
  assert.match(context.calls[2].url, /accounts\/only\/billing\/summary\?/);
  assert.equal(context.calls[0].headers.authorization, "Bearer alias-key");
});
test("fireworks: stale configured slug retries discovery on 404", async () => {
  const context = fakeContext({
    env,
    responses: [json({}, 404), json({ accounts: [{ id: "new-slug" }] }), ...payloads.map((p) => json(p))],
  });
  await fireworks.fetch(context);
  assert.match(context.calls[2].url, /new-slug\/billing\/summary/);
});
for (const accounts of [[], [{ id: "one" }, { id: "two" }]])
  test("fireworks: ambiguous or absent accounts fail", async () => {
    await assert.rejects(
      fireworks.fetch(fakeContext({ env: { FIREWORKS_API_KEY: "key" }, responses: [json({ accounts })] })),
      HttpError,
    );
  });
test("fireworks: repeated cursor fails", async () => {
  await assert.rejects(
    fireworks.fetch(
      fakeContext({
        env: { FIREWORKS_API_KEY: "key" },
        responses: [json({ nextPageToken: "same" }), json({ nextPageToken: "same" })],
      }),
    ),
    HttpError,
  );
});
test("fireworks: empty summary validates configured account", async () => {
  const [account] = await fireworks.fetch(
    fakeContext({ env, responses: [json({ lineItems: [] }), json({ accounts: [{ id: "test-account" }] })] }),
  );
  assert.deepEqual(account.windows, []);
});
