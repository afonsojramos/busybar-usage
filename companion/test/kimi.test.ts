import assert from "node:assert/strict";
import { test } from "node:test";
import { kimi } from "../src/providers/kimi.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const reset = "2026-12-01T12:00:00Z";
// CodexBar KimiProviderTests count fixture, with future reset dates.
const legacy = { usage: { limit: "2048", used: "214", remaining: "1834", resetTime: reset },
  limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
    detail: { limit: "200", used: "139", remaining: "61", resetTime: reset } }] };
const env = { KIMI_CODE_API_KEY: "fake-kimi-key" };
const credential = (fields: Record<string, unknown> = {}) => JSON.stringify({ access_token: "fake-cli-token",
  refresh_token: "fake-refresh", expires_at: NOW + 3600, ...fields });

test("Kimi Code legacy fixture yields 5h and weekly quotas", async () => {
  const context = fakeContext({ env, responses: [json(legacy)] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    return fetch(input, init);
  };
  const [account] = await kimi.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.minutes, w.used_percent]), [["5h", 300, 70], ["7d", 10080, 10]]);
  assert.equal(account.account, "default");
  assert.equal(context.calls[0].url, "https://api.kimi.com/coding/v1/usages");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-kimi-key");
});

test("Kimi ratio fixture keeps shortest pools but exhausted monthly still blocks", async () => {
  const context = fakeContext({ env, responses: [json({ usages: {
    limit_5h: { used_ratio: 0.625, reset_time: reset }, limit_7d: { used_ratio: 0.125, reset_time: reset },
    limit_month_total: { used_ratio: 1.05, reset_time: reset }, limit_month_code: { invalid: true },
  }, user: { email: "fake@example.org" } })] });
  const [account] = await kimi.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent]), [["5h", 63], ["7d", 13]]);
  assert.equal(account.blocked, true);
  assert.equal(account.account, "example");
});

test("Kimi monthly-only and missing-weekly ratios stay available", async () => {
  for (const usages of [{ limit_month_total: { used_ratio: 0.42 } },
    { limit_5h: { used_ratio: 0 }, limit_month_total: { used_ratio: 0.42 } }]) {
    const [account] = await kimi.fetch(fakeContext({ env, responses: [json({ usages })] }));
    assert.equal(account.windows.at(-1)?.name, "30d");
    assert.equal(account.windows.at(-1)?.minutes, 43200);
  }
});

test("Kimi only borrows more exhausted legacy counts for matching periods", async () => {
  for (const [countReset, expected] of [[reset, 19], ["2026-12-02T12:00:00Z", 0], [null, 0]]) {
    const [account] = await kimi.fetch(fakeContext({ env, responses: [json({
      usage: { limit: "100", used: "19", resetTime: countReset },
      usages: { limit_7d: { used_ratio: 0, reset_time: reset } },
    })] }));
    assert.equal(account.windows[0].used_percent, expected);
  }
});

test("Kimi legacy remaining, duration units, aliases and invalid counters", async () => {
  for (const [unit, duration, minutes] of [["TIME_UNIT_HOUR", 2, 120], ["TIME_UNIT_DAY", 1, 1440], ["UNKNOWN", 1, null]]) {
    const [account] = await kimi.fetch(fakeContext({ env, responses: [json({ limits: [{
      window: { duration, timeUnit: unit }, detail: { limit: 100, remaining: 20, reset_at: reset },
    }] })] }));
    assert.equal(account.windows[0].minutes, minutes);
    assert.equal(account.windows[0].used_percent, 80);
    assert.equal(account.windows[0].resets_at, Date.parse(reset) / 1000);
  }
  const [account] = await kimi.fetch(fakeContext({ env, responses: [json({ usage: { limit: 100, used: -1 } })] }));
  assert.equal(account.windows[0].minutes, null);
});

test("Kimi reads fresh CLI credentials and identity without rewriting them", async () => {
  for (const device of ["fake-device", undefined]) {
    const files: Record<string, string> = { "/custom/credentials/kimi-code.json": credential() };
    if (device) files["/custom/device_id"] = device;
    const context = fakeContext({ env: { KIMI_CODE_HOME: "/custom" }, files, responses: [json(legacy)] });
    await kimi.fetch(context);
    assert.equal(context.calls[0].headers.authorization, "Bearer fake-cli-token");
    assert.equal(context.calls[0].headers["x-msh-platform"], "kimi_code_cli");
    if (device) assert.equal(context.calls[0].headers["x-msh-device-id"], device);
    else assert.match(context.calls[0].headers["x-msh-device-id"], /^[a-f0-9-]{36}$/);
    assert.ok(context.calls[0].headers["x-msh-device-name"]);
  }
});

test("Kimi stale, missing-expiry and refresh-only credentials ask for sign in", async () => {
  for (const fields of [{ expires_at: NOW + 60 }, { expires_at: null }, { access_token: "" }]) {
    const context = fakeContext({ files: { "/home/test/.kimi-code/credentials/kimi-code.json": credential(fields) } });
    assert.equal((await kimi.fetch(context))[0].error, "sign in");
    assert.equal(context.calls.length, 0);
  }
});

test("Kimi API key wins over CLI and uses saved international region", async () => {
  const context = fakeContext({ env, files: {
    "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [{ id: "kimi", region: "international" }] }),
    "/home/test/.kimi-code/credentials/kimi-code.json": credential(),
  }, responses: [json(legacy)] });
  await kimi.fetch(context);
  assert.equal(context.calls[0].url, "https://api.kimi.ai/coding/v1/usages");
  assert.equal(context.calls[0].headers["x-msh-platform"], undefined);
});

test("Kimi key supports HTTPS endpoint paths and rejects unsafe overrides", async () => {
  for (const path of ["", "/coding", "/coding/v1"]) {
    const context = fakeContext({ env: { ...env, KIMI_CODE_BASE_URL: `https://api.kimi.ai${path}` }, responses: [json(legacy)] });
    await kimi.fetch(context);
    assert.equal(context.calls[0].url, "https://api.kimi.ai/coding/v1/usages");
  }
  for (const url of ["https://example.org", "http://api.kimi.com", "https://fake:secret@api.kimi.com", "invalid", "https://api.kimi.com?x=1"]) {
    await assert.rejects(kimi.fetch(fakeContext({ env: { ...env, KIMI_CODE_BASE_URL: url } })), HttpError);
  }
});

test("Kimi never forwards CLI credentials to overrides or international hosts", async () => {
  for (const extra of [{ KIMI_CODE_BASE_URL: "https://example.org" }, { KIMI_CODE_OAUTH_HOST: "https://example.org" },
    { KIMI_OAUTH_HOST: "https://example.org" }]) {
    await assert.rejects(kimi.fetch(fakeContext({ env: extra,
      files: { "/home/test/.kimi-code/credentials/kimi-code.json": credential() } })), NotConfigured);
  }
  await assert.rejects(kimi.fetch(fakeContext({ files: {
    "/home/test/.kimi-code/credentials/kimi-code.json": credential(),
    "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [{ id: "kimi", region: "international" }] }),
  } })), NotConfigured);
});

test("Kimi missing or invalid credentials mean not configured", async () => {
  for (const text of [null, "invalid", "{}", credential({ access_token: "", refresh_token: "" })]) {
    const files: Record<string, string> = text ? { "/home/test/.kimi-code/credentials/kimi-code.json": text } : {};
    await assert.rejects(kimi.fetch(fakeContext({ files })), NotConfigured);
  }
});

for (const status of [401, 403]) test(`Kimi ${status} asks to sign in`, async () => {
  assert.equal((await kimi.fetch(fakeContext({ env, responses: [json({}, status)] })))[0].error, "sign in");
});
for (const seconds of [null, "120"]) test(`Kimi rate limit ${seconds}`, async () => {
  await assert.rejects(kimi.fetch(fakeContext({ env, responses: [json({}, 429, seconds ? { "retry-after": seconds } : {})] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + (seconds ? 120 : 300));
});
for (const response of [json({}, 500), new Response("fake-secret-invalid-json"), json({}), json({ usages: {} }),
  json({ usages: { limit_5h: { used_ratio: -1 } } }), json({ usage: { limit: "1e100", used: 1 } })]) {
  test("Kimi invalid responses raise sanitized HttpError", async () => {
    await assert.rejects(kimi.fetch(fakeContext({ env, responses: [response] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("fake-secret"));
  });
}
