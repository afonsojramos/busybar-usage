import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { stepfun, parseUsage } from "../src/providers/stepfun.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, jwt, NOW } from "./helpers.ts";

const usage = {
  status: 1,
  five_hour_usage_left_rate: 0.75,
  weekly_usage_left_rate: 0.5,
  five_hour_usage_reset_time: String(NOW + 3600),
  weekly_usage_reset_time: NOW + 604800,
};
const env = { STEPFUN_TOKEN: "fake-token" };
test("StepFun parses CodexBar rate fixture and matches the token device id", async () => {
  const token = `${jwt({ device_id: "wrong" })}...${jwt({ device_id: "device-fixture" })}`;
  const c = fakeContext({ env: { STEPFUN_TOKEN: `Oasis-Token=${token}; other=fake` }, responses: [json(usage)] });
  const [a] = await stepfun.fetch(c);
  assert.deepEqual(
    a?.windows.map((w) => [w.minutes, w.used_percent]),
    [
      [300, 25],
      [10080, 50],
    ],
  );
  assert.equal(c.calls[0]?.headers["oasis-webid"], "device-fixture");
  assert.equal(c.calls[0]?.headers.cookie, `Oasis-Token=${token}; Oasis-Webid=device-fixture`);
  assert.match(c.calls[0]?.url ?? "", /QueryStepPlanRateLimit$/);
});
test("StepFun needs credentials", async () => {
  await assert.rejects(stepfun.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`StepFun ${status} needs sign in`, async () => {
    assert.equal((await stepfun.fetch(fakeContext({ env, responses: [json({}, status)] })))[0]?.error, "sign in");
  });
test("StepFun honors rate limits", async () => {
  await assert.rejects(
    stepfun.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    (e: unknown) => e instanceof RateLimited && e.until === NOW + 42,
  );
});
test("StepFun rejects malformed and failed responses", async () => {
  for (const response of [json({ status: 1 }), json({ status: 0 }), new Response("secret-body"), json({}, 500)])
    await assert.rejects(stepfun.fetch(fakeContext({ env, responses: [response] })), HttpError);
});
test("StepFun credit plans weight bucket balances and preserve unknown reset", () => {
  const windows = parseUsage(
    {
      status: 1,
      plan_family: 2,
      plan_credit_rate_limit: {
        subscription_credit_left_rate: 0.8,
        topup_credit_left_rate: 0.5,
        credit_buckets: [
          { credit_total: "100", credit_residual: "80" },
          { credit_total: 900, credit_residual: 450 },
        ],
      },
    },
    NOW,
  );
  assert.equal(windows[0]?.used_percent, 47);
  assert.equal(windows[0]?.minutes, null);
  assert.equal(windows[0]?.resets_at, null);
});
test("StepFun credits use independent subscription fraction when buckets invalid", () => {
  assert.equal(
    parseUsage(
      {
        status: 1,
        plan_family: 2,
        plan_credit_rate_limit: {
          subscription_credit_left_rate: 0.8,
          topup_credit_left_rate: 0.5,
          credit_buckets: [{ credit_total: 0 }],
        },
      },
      NOW,
    )[0]?.used_percent,
    20,
  );
  assert.deepEqual(parseUsage({ status: 1, plan_family: 2 }, NOW), []);
  assert.equal(parseUsage({ ...usage, plan_family: 2, plan_credit_rate_limit: {} }, NOW)[0]?.minutes, 300);
});
test("StepFun logs in with credentials using CodexBar's three steps", async () => {
  const c = fakeContext({
    env: { STEPFUN_USERNAME: "fake@example.com", STEPFUN_PASSWORD: "fake-password" },
    responses: [
      new Response("", { headers: { "set-cookie": "INGRESSCOOKIE=fake-ingress; Path=/" } }),
      json({ accessToken: { raw: "fake-anon" } }),
      json({ accessToken: { raw: "fake-access" }, refreshToken: { raw: "fake-refresh" } }),
      json(usage),
    ],
  });
  const [a] = await stepfun.fetch(c);
  assert.equal(a?.windows.length, 2);
  assert.equal(a?.account, "example");
  assert.equal(c.calls.length, 4);
  assert.match(c.calls[1]?.url ?? "", /RegisterDevice$/);
  assert.match(c.calls[2]?.url ?? "", /SignInByPassword$/);
  assert.match(c.calls[3]?.headers.cookie ?? "", /Oasis-Token=fake-access\.\.\.fake-refresh/);
});
test("StepFun keeps a password-login token for the run and logs in again once it is rejected", async () => {
  const c = fakeContext({
    env: { STEPFUN_USERNAME: "fake@example.com", STEPFUN_PASSWORD: "fake-password" },
    responses: [
      new Response("", { headers: { "set-cookie": "INGRESSCOOKIE=fake-ingress; Path=/" } }),
      json({ accessToken: { raw: "fake-anon" } }),
      json({ accessToken: { raw: "fake-access" }, refreshToken: { raw: "fake-refresh" } }),
      json(usage),
      json(usage),
      json({}, 401),
      new Response("", { headers: { "set-cookie": "INGRESSCOOKIE=fake-ingress; Path=/" } }),
      json({ accessToken: { raw: "fake-anon" } }),
      json({ accessToken: { raw: "fake-access-2" }, refreshToken: { raw: "fake-refresh" } }),
      json(usage),
    ],
  });
  await stepfun.fetch(c);
  await stepfun.fetch(c);
  assert.equal(c.calls.length, 5, "the second poll reuses the session");
  assert.equal((await stepfun.fetch(c))[0]?.error, "sign in");
  await stepfun.fetch(c);
  assert.match(c.calls.at(-1)?.headers.cookie ?? "", /Oasis-Token=fake-access-2/);
});
test("StepFun reads CodexBar region token and cookie off", async () => {
  const file = "/home/test/.config/codexbar/config.json";
  const c = fakeContext({
    files: { [file]: JSON.stringify({ providers: [{ id: "stepfun", region: "fake-region-token" }] }) },
    responses: [json(usage)],
  });
  await stepfun.fetch(c);
  assert.match(c.calls[0]?.headers.cookie ?? "", /fake-region-token/);
  await assert.rejects(
    stepfun.fetch(
      fakeContext({ env, files: { [file]: JSON.stringify({ providers: [{ id: "stepfun", cookieSource: "off" }] }) } }),
    ),
    NotConfigured,
  );
});
