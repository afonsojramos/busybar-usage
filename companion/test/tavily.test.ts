import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { tavily } from "../src/providers/tavily.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { TAVILY_API_KEY: "fixture-key" };
// Synthetic response derived from CodexBar's TavilyPluginTests.
const fixture = {
  key: { usage: 100, limit: 200 },
  account: { plan_usage: 500, plan_limit: 1000, paygo_usage: 25, paygo_limit: 100 },
};

test("tavily: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await tavily.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "tavily");
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => String(w.used_percent ?? w.value)),
    ["50", "50"],
  );
  assert.ok(account.windows.every((w) => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["authorization"], "Bearer fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://api.tavily.com");
  assert.equal(context.calls[0]?.url, "https://api.tavily.com/usage");
  assert.equal(context.runs.length, 0);
});

test("tavily: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(tavily.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("tavily: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({
      env,
      responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })],
    });
    if (status === 401 || status === 403) {
      assert.equal((await tavily.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(tavily.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(tavily.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("tavily: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(
      tavily.fetch(context),
      (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"),
    );
  }
});

test("tavily: unlimited key, zero plan limit and invalid totals", async () => {
  const [account] = await tavily.fetch(
    fakeContext({
      env,
      responses: [json({ key: { usage: 10, limit: null }, account: { plan_usage: 0, plan_limit: 0 } })],
    }),
  );
  assert.deepEqual(
    account?.windows.map((w) => w.used_percent),
    [null, null],
  );
  for (const fields of [{ plan_usage: "1" }, { plan_limit: -1 }, { paygo_limit: undefined }])
    await assert.rejects(
      tavily.fetch(fakeContext({ env, responses: [json({ ...fixture, account: { ...fixture.account, ...fields } })] })),
      HttpError,
    );
});

test("tavily: companion and CodexBar saved API keys", async () => {
  const entry = { id: "tavily", apiKey: "saved-key" };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { tavily: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture)] });
    await tavily.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some((value) => value.includes("saved-key")));
  }
});
