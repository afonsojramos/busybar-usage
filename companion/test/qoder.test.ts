import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { qoder } from "../src/providers/qoder.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const config = (cookieHeader = "session=fake") => ({
  "/home/test/.config/busybar-usage/config.json": JSON.stringify({
    providers: { qoder: { cookieHeader, cookieSource: "manual" } },
  }),
});
const fixture = {
  totalQuota: {
    quotaSummary: { usedValue: 125, limitValue: 500, remainingValue: 375, usagePercentage: 25, unit: "credit" },
  },
  nextResetAt: (NOW + 3600) * 1000,
};

test("Qoder parses CodexBar member quota and request headers", async () => {
  const context = fakeContext({ files: config(), responses: [json(fixture)] });
  const [account] = await qoder.fetch(context);
  assert.equal(account?.windows[0]?.used_percent, 25);
  assert.equal(account?.windows[0]?.resets_at, NOW + 3600);
  assert.equal(account?.windows[0]?.minutes, null);
  assert.equal(context.calls[0]?.url, "https://qoder.com/api/v2/me/usages/big_model_credits");
  assert.equal(context.calls[0]?.headers["bx-v"], "2.5.35");
});
test("Qoder missing credentials", async () => {
  await assert.rejects(qoder.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`Qoder ${status} signs in without crossing origins`, async () => {
    const context = fakeContext({ files: config(), responses: [json({}, status)] });
    assert.equal((await qoder.fetch(context))[0]?.error, "sign in");
    assert.equal(context.calls.length, 1);
  });
test("Qoder rate limited", async () => {
  await assert.rejects(
    qoder.fetch(fakeContext({ files: config(), responses: [json({}, 429, { "retry-after": "42" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 42,
  );
});
test("Qoder folds shared quotas instead of using base percentage", async () => {
  const data = { ...fixture, sharedQuota: { quotaSummary: { usedValue: 375, limitValue: 500 } } };
  assert.equal(
    (await qoder.fetch(fakeContext({ files: config(), responses: [json(data)] })))[0]?.windows[0]?.used_percent,
    50,
  );
});
test("Qoder supports snake case and exhausted zero total", async () => {
  const data = { total_quota: { quota_summary: { used_value: 0, limit_value: 0 } } };
  assert.equal((await qoder.fetch(fakeContext({ files: config(), responses: [json(data)] })))[0]?.blocked, true);
});
test("Qoder binds China capture to China and strips capture headers", async () => {
  const context = fakeContext({
    files: config("curl 'https://qoder.com.cn/api/v2/me/usages/big_model_credits' -H 'Cookie: session=fake'"),
    responses: [json(fixture)],
  });
  await qoder.fetch(context);
  assert.equal(context.calls[0]?.url, "https://qoder.com.cn/api/v2/me/usages/big_model_credits");
  assert.equal(context.calls[0]?.headers.cookie, "session=fake");
});
test("Qoder rejects mixed-origin captures", async () => {
  const context = fakeContext({ files: config("curl 'https://evil.test/' -H 'Cookie: session=fake'") });
  await assert.rejects(qoder.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});
for (const data of [
  {},
  { totalQuota: { quotaSummary: { usedValue: -1, limitValue: 5 } } },
  { totalQuota: { quotaSummary: { usedValue: 1, limitValue: 0 } } },
]) {
  test("Qoder rejects malformed quota", async () => {
    await assert.rejects(qoder.fetch(fakeContext({ files: config(), responses: [json(data)] })), HttpError);
  });
}
test("Qoder masks invalid JSON and server failures", async () => {
  for (const response of [new Response("secret", { status: 200 }), json({}, 500)]) {
    await assert.rejects(qoder.fetch(fakeContext({ files: config(), responses: [response] })), HttpError);
  }
});

for (const capture of [
  "session=fake; Domain=.qoder.com.cn",
  "curl https://qoder.com.cn/account/usage --header='Cookie: session=fake'",
  "curl https://qoder.com.cn/account/usage -H'Cookie: session=fake'",
  "curl https://qoder.com.cn/account/usage -fsSLH'Cookie: session=fake'",
  "curl https://qoder.com.cn/account/usage -fsSLH 'Cookie: session=fake'",
  "curl https://qoder.com.cn/account/usage --cookie 'session=fake'",
  "curl https://qoder.com.cn/account/usage -bsession=fake",
  "curl --url=https://qoder.com.cn/account/usage -b 'session=fake'",
  "ENV=value /usr/bin/curl --url 'https://qoder.com.cn/account/usage' -H 'Cookie: session=fake'",
  "curl https://qoder.com.cn/account/usage \\\n -H 'Cookie: session=fake'",
  "GET /api/v2/me/usages/big_model_credits HTTP/1.1\nHost: qoder.com.cn\nCookie: session=fake",
  "GET https://qoder.com.cn/account/usage HTTP/1.1\nCookie: session=fake",
])
  test(`Qoder safely normalizes China capture ${JSON.stringify(capture)}`, async () => {
    const context = fakeContext({ files: config(capture), responses: [json(fixture)] });
    await qoder.fetch(context);
    assert.equal(context.calls[0]?.url, "https://qoder.com.cn/api/v2/me/usages/big_model_credits");
    assert.match(context.calls[0]?.headers.cookie ?? "", /^session=fake/);
  });
for (const capture of [
  "session=fake; Domain=qoder.com.cn; Domain=qoder.com",
  "session=fake; Domain=evil.test",
  "curl https://qoder.com.cn/ https://qoder.com/ -b session=fake",
  "curl https://qoder.com.cn/ -H 'Host: qoder.com' -b session=fake",
  "curl https://qoder.com.cn/ -H ' Host: qoder.com' -b session=fake",
  "curl https://[invalid/ -b session=fake",
  "curl -s https://qoder.com.cn/ -b session=fake",
  "curl https://qoder.com.cn/ --config secret -b session=fake",
  "curl https://qoder.com.cn/ -H 'Cookie: session=fake'; echo leaked",
  'curl https://qoder.com.cn/ -b "session=$TOKEN"',
  "curl https://qoder.com.cn/ -b 'session=fake",
  "GET /api/path HTTP/1.1\nCookie: session=fake",
  "TRACE https://qoder.com.cn/ HTTP/1.1\nCookie: session=fake",
  "GET https://qoder.com.cn/ HTTP/1.1\nHost: qoder.com\nCookie: session=fake",
])
  test("Qoder rejects unsafe or ambiguous capture without requests", async () => {
    const context = fakeContext({ files: config(capture) });
    await assert.rejects(
      qoder.fetch(context),
      (error: unknown) => error instanceof NotConfigured && !error.message.includes("session="),
    );
    assert.equal(context.calls.length, 0);
  });
