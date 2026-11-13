import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { exa } from "../src/providers/exa.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { EXA_SERVICE_KEY: "fixture-key", EXA_API_KEY_ID: "key/fixture" };
// Synthetic response derived from CodexBar's ExaPluginTests.
const fixture = {
  total_cost_usd: 12.5,
  period: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-13T05:06:40.000Z" },
};
fixture.period.end = new Date(NOW * 1000).toISOString();

test("exa: documented response and request contract", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    assert.equal(init.redirect, "error");
    return fetch(input, init);
  };
  const [account] = await exa.fetch(context);
  assert.ok(account);
  assert.equal(account.provider, "exa");
  assert.equal(account.account, "default");
  assert.deepEqual(
    account.windows.map((w) => String(w.used_percent ?? w.value)),
    ["$12.50"],
  );
  assert.ok(account.windows.every((w) => !w.value || w.value.length <= 12));
  assert.equal(context.calls[0]?.headers["x-api-key"], "fixture-key");
  assert.equal(new URL(context.calls[0]!.url).origin, "https://admin-api.exa.ai");
  assert.equal(context.runs.length, 0);
});

test("exa: missing credentials", async () => {
  const context = fakeContext({});
  await assert.rejects(exa.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("exa: HTTP errors are classified without exposing secrets", async () => {
  for (const status of [401, 403, 429, 400, 500]) {
    const context = fakeContext({
      env,
      responses: [json({ secret: "private-response" }, status, { "retry-after": "37" })],
    });
    if (status === 401 || status === 403) {
      assert.equal((await exa.fetch(context))[0]?.error, "sign in");
    } else if (status === 429) {
      await assert.rejects(exa.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 37);
    } else await assert.rejects(exa.fetch(context), HttpError);
    assert.equal(context.calls.length, 1);
  }
});

test("exa: invalid JSON and shapes fail safely", async () => {
  for (const body of ["private-response", "null", "[]", "{}"]) {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(
      exa.fetch(context),
      (e: unknown) => e instanceof HttpError && !e.message.includes("private-response"),
    );
  }
});

test("exa: scope is encoded and exact returned period is required", async () => {
  const context = fakeContext({ env, responses: [json(fixture)] });
  await exa.fetch(context);
  assert.equal(new URL(context.calls[0]!.url).pathname, "/team-management/api-keys/key%2Ffixture/usage");
  await assert.rejects(
    exa.fetch(
      fakeContext({
        env,
        responses: [
          json({ ...fixture, period: { ...fixture.period, end: fixture.period.end.replace(".000Z", ".001Z") } }),
        ],
      }),
    ),
    HttpError,
  );
  for (const scope of ["", ".", ".."])
    await assert.rejects(exa.fetch(fakeContext({ env: { ...env, EXA_API_KEY_ID: scope } })), NotConfigured);
  await assert.rejects(
    exa.fetch(fakeContext({ env, responses: [json({ ...fixture, total_cost_usd: -1 })] })),
    HttpError,
  );
});

test("exa: companion and CodexBar saved API keys", async () => {
  const entry = { id: "exa", apiKey: "saved-key", workspaceID: "scope-fixture" };
  for (const [path, config] of [
    ["/home/test/.config/busybar-usage/config.json", { providers: { exa: entry } }],
    ["/home/test/.config/codexbar/config.json", { providers: [entry] }],
  ] satisfies [string, unknown][]) {
    const context = fakeContext({ files: { [path]: JSON.stringify(config) }, responses: [json(fixture)] });
    await exa.fetch(context);
    assert.ok(Object.values(context.calls[0]?.headers ?? {}).some((value) => value.includes("saved-key")));
  }
});
