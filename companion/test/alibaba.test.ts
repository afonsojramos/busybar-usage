import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { alibaba } from "../src/providers/alibaba.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Based on AlibabaCodingPlanProviderTests' codingPlanQuotaInfo response.
const quota = {
  code: "200",
  data: {
    codingPlanInstanceInfos: [{ planName: "Pro", status: "ACTIVE" }],
    codingPlanQuotaInfo: {
      per5HourUsedQuota: 52,
      per5HourTotalQuota: 1000,
      per5HourQuotaNextRefreshTime: (NOW + 300) * 1000,
      perWeekUsedQuota: 800,
      perWeekTotalQuota: 5000,
      perWeekQuotaNextRefreshTime: (NOW + 10000) * 1000,
      perBillMonthUsedQuota: 1000,
      perBillMonthTotalQuota: 10000,
    },
  },
};
const env = { ALIBABA_CODING_PLAN_API_KEY: "fake-key" };
const files = {
  "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { alibaba: { region: "cn" } } }),
};
test("Alibaba API key maps coding-plan quotas, drops monthly third lane", async () => {
  const c = fakeContext({ env, responses: [json(quota)] });
  const [a] = await alibaba.fetch(c);
  assert.deepEqual(
    a.windows.map((w) => [w.name, w.used_percent]),
    [
      ["5h", 5],
      ["7d", 16],
    ],
  );
  assert.equal(c.calls[0].headers.authorization, "Bearer fake-key");
  assert.equal(c.calls[0].headers["x-dashscope-api-key"], "fake-key");
  assert.match(c.calls[0].url, /modelstudio.console.alibabacloud.com/);
});
test("Alibaba missing credentials", async () => {
  await assert.rejects(alibaba.fetch(fakeContext({})), NotConfigured);
});
test("Alibaba rejected credentials", async () => {
  const [a] = await alibaba.fetch(fakeContext({ env, files, responses: [json({}, 401)] }));
  assert.equal(a.error, "sign in");
});
test("Alibaba 429", async () => {
  await assert.rejects(
    alibaba.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "42" })] })),
    (e) => e instanceof RateLimited && e.until === NOW + 42,
  );
});
test("Alibaba malformed body", async () => {
  await assert.rejects(alibaba.fetch(fakeContext({ env, files, responses: [json({})] })), HttpError);
});
test("Alibaba cookie source precedes key and uses console gateway", async () => {
  const c = fakeContext({
    env: { ...env, ALIBABA_CODING_PLAN_COOKIE: "session=fake; cna=fake" },
    responses: [new Response('SEC_TOKEN: "fake-sec"'), json(quota)],
  });
  assert.equal((await alibaba.fetch(c))[0].windows.length, 2);
  assert.equal(c.calls[1].headers.cookie, "session=fake; cna=fake");
  assert.equal(c.calls[1].headers.authorization, undefined);
  assert.match(c.calls[1].url, /bailian-singapore-cs/);
});
test("Alibaba active instance never borrows expired instance quota", async () => {
  const c = fakeContext({
    env,
    responses: [
      json({
        data: {
          codingPlanInstanceInfos: [
            {
              planName: "old",
              status: "EXPIRED",
              codingPlanQuotaInfo: { per5HourUsedQuota: 90, per5HourTotalQuota: 100 },
            },
            { planName: "Pro", status: "ACTIVE" },
          ],
        },
      }),
    ],
  });
  assert.deepEqual((await alibaba.fetch(c))[0].windows, []);
});
test("Alibaba unsafe endpoint rejects before transmitting key", async () => {
  await assert.rejects(
    alibaba.fetch(fakeContext({ env: { ...env, ALIBABA_CODING_PLAN_HOST: "https://attacker.example" } })),
    NotConfigured,
  );
});

test("Alibaba manual empty cookie never imports a browser account", async () => {
  for (const cookieHeader of [undefined, "", "   "]) {
    const c = fakeContext({
      files: {
        "/home/test/.config/busybar-usage/config.json": JSON.stringify({
          providers: { alibaba: { cookieSource: "manual", cookieHeader } },
        }),
      },
    });
    c.querySqlite = async () => {
      throw new Error("browser cookie import must not run");
    };
    c.listDir = async () => {
      throw new Error("browser profile discovery must not run");
    };
    await assert.rejects(alibaba.fetch(c), NotConfigured);
    assert.equal(c.calls.length, 0);
  }
});
test("Alibaba manual empty cookie preserves API-key fallback", async () => {
  const c = fakeContext({
    env,
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { alibaba: { cookieSource: "manual", cookieHeader: "" } },
      }),
    },
    responses: [json(quota)],
  });
  c.querySqlite = async () => {
    throw new Error("browser cookie import must not run");
  };
  assert.equal((await alibaba.fetch(c))[0].windows.length, 2);
});
test("Alibaba accepts the provider-owned Beijing quota gateway override", async () => {
  const c = fakeContext({
    env: { ...env, ALIBABA_CODING_PLAN_QUOTA_URL: "https://bailian-beijing-cs.aliyuncs.com/data/api.json" },
    responses: [json(quota)],
  });
  assert.equal((await alibaba.fetch(c))[0].windows.length, 2);
  assert.equal(new URL(c.calls[0].url).host, "bailian-beijing-cs.aliyuncs.com");
  assert.equal(c.calls[0].headers.authorization, "Bearer fake-key");
});
