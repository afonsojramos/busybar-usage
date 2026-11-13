import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { litellm } from "../src/providers/litellm.ts";
import { isRecord } from "../src/feed.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

function fixture(name = "usage"): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`./fixtures/litellm/${name}.json`, import.meta.url), "utf8"));
  return record(value);
}

const env = { LITELLM_API_KEY: "fake-key", LITELLM_BASE_URL: "https://gateway.example/prefix/v1/" };

for (const status of [401, 403]) {
  test(`litellm returns sign in for HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status), json({}, status), json({}, status)] });
    const [account] = await litellm.fetch(context);
    assert.equal(account.error, "sign in");
    assert.deepEqual(account.windows, []);
    assert.equal(account.account, "default");
  });
}

for (const retry of [null, "17"]) {
  test(`litellm honors rate limiting (${retry})`, async () => {
    const context = fakeContext({ env, responses: [json({}, 429, retry === null ? {} : { "retry-after": retry })] });
    await assert.rejects(litellm.fetch(context), (error: unknown) => {
      assert.ok(error instanceof RateLimited);
      assert.equal(error.until, NOW + (retry === null ? 300 : 17));
      return true;
    });
    assert.equal(context.calls.length, 1);
  });
}

for (const status of [400, 500]) {
  test(`litellm sanitizes HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [new Response("secret body", { status })] });
    await assert.rejects(litellm.fetch(context), (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  });
}

for (const body of ["not JSON secret", "[]"]) {
  test(`litellm rejects malformed response ${body}`, async () => {
    const context = fakeContext({ env, responses: [new Response(body)] });
    await assert.rejects(litellm.fetch(context), HttpError);
  });
}

test("litellm rejects unsafe endpoints before sending credentials", async () => {
  for (const host of ["http://public.example", "https://user:fake@private.example", "ftp://localhost"]) {
    const context = fakeContext({ env: { ...env, LITELLM_BASE_URL: host } });
    await assert.rejects(litellm.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
});

test("litellm adds a deadline and refuses redirects", async () => {
  const context = fakeContext({ env });
  context.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.redirect, "error");
    return json({}, 401);
  };
  const [account] = await litellm.fetch(context);
  assert.equal(account.error, "sign in");
});

test("litellm skips when no key is configured", async () => {
  const context = fakeContext({ env: { LITELLM_BASE_URL: env.LITELLM_BASE_URL } });
  await assert.rejects(litellm.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("litellm requires a base URL", async () => {
  const context = fakeContext({ env: { LITELLM_API_KEY: "fake-key" } });
  await assert.rejects(litellm.fetch(context), NotConfigured);
  assert.equal(context.calls.length, 0);
});

test("litellm reads CodexBar personal and matching-team budgets", async () => {
  const context = fakeContext({ env, responses: [json({ info: { user_id: "user-123", team_id: "team-456" } }), json(fixture())] });
  context.now = () => Date.parse("2026-06-01T00:00:00Z") / 1000;
  const [account] = await litellm.fetch(context);
  assert.equal(account.account, "example");
  assert.deepEqual(account.windows.map((w) => [w.name, w.minutes, w.used_percent]),
    [["7d", 10080, 22], ["user", null, 71]]);
  assert.deepEqual(context.calls.map((call) => call.url), [
    "https://gateway.example/prefix/key/info", "https://gateway.example/prefix/user/info?user_id=user-123",
  ]);
  assert.ok(context.calls.every((call) => call.headers.authorization === "Bearer fake-key"));
});

test("litellm handles team-only and personal spend-only keys", async () => {
  const [team] = await litellm.fetch(fakeContext({ env, responses: [json({ info: { team_id: "team-456" } }),
    json({ team_info: { team_id: "team-456", spend: 25 } })] }));
  assert.equal(team.windows[0].value, "$25.00");
  const [user] = await litellm.fetch(fakeContext({ env, responses: [json({ info: { user_id: "u" } }),
    json({ user_info: { user_id: "u", spend: 12.5 } })] }));
  assert.equal(user.windows[0].value, "$12.50");
});

test("litellm uses key reports before user reports with UTC month-to-date bounds", async () => {
  for (const keyAvailable of [true, false]) {
    const context = fakeContext({ env, responses: [json({}, 403),
      ...(keyAvailable ? [] : [json({}, 404)]), json([{ total_cost: 1.25 }, { total_cost: 2.5, models: [{ total_cost: 100 }] }])] });
    const [account] = await litellm.fetch(context);
    assert.equal(account.windows[0].value, "$3.75");
    const paths = context.calls.map((call) => new URL(call.url).pathname);
    assert.deepEqual(paths, ["/prefix/key/info", "/prefix/key/spend/report", ...(!keyAvailable ? ["/prefix/user/spend/report"] : [])]);
    const query = new URL(context.calls.at(-1)?.url ?? "https://unused.test").searchParams;
    const end = new Date(NOW * 1000).toISOString().slice(0, 10);
    assert.equal(query.get("start_date"), end.slice(0, 7) + "-01");
    assert.equal(query.get("end_date"), end);
    assert.equal(query.has("api_key"), false);
    assert.equal(query.has("internal_user_id"), false);
  }
});

test("litellm preserves zero reports and rejects empty, invalid and failed reports", async () => {
  const [zero] = await litellm.fetch(fakeContext({ env, responses: [json({}, 404), json([{ total_cost: 0 }])] }));
  assert.equal(zero.windows[0].value, "$0.00");
  for (const report of [[], [{}], [{ total_cost: -1 }], [{ total_cost: "1" }]]) {
    await assert.rejects(litellm.fetch(fakeContext({ env, responses: [json({}, 404), json(report)] })), HttpError);
  }
  await assert.rejects(litellm.fetch(fakeContext({ env, responses: [json({}, 404), json({}, 500)] })), HttpError);
  await assert.rejects(litellm.fetch(fakeContext({ env, responses: [json({}, 404), json({}, 429)] })), RateLimited);
});

test("litellm pairs member limits only with matching team-scoped spend", async () => {
  const context = fakeContext({ env, responses: [json({ info: { user_id: "u", team_id: "t" } }), json({
    user_info: { user_id: "u", spend: 900 }, teams: [{ team_id: "t", spend: 60, max_budget: 100,
      team_memberships: [{ user_id: "u", team_id: "t", litellm_budget_table: { max_budget: 20 } }] }],
  }), json({ team_info: { team_id: "t", team_memberships: [{ user_id: "u", team_id: "t", spend: 5,
    litellm_budget_table: { max_budget: 10 } }] } })] });
  const [account] = await litellm.fetch(context);
  assert.deepEqual(account.windows.map((w) => [w.name, w.used_percent]), [["member", 25], ["team", 60]]);
  assert.equal(context.calls.length, 3);
});

test("litellm uses inline membership and team default budgets without user-wide spend", async () => {
  const key = { info: { user_id: "u", team_id: "t" } };
  const [inline] = await litellm.fetch(fakeContext({ env, responses: [json(key), json({
    user_info: { spend: 999 }, teams: [{ team_id: "t", max_budget: 100, spend: 20,
      team_memberships: [{ user_id: "u", team_id: "t", spend: 3, litellm_budget_table: { max_budget: 10 } }] }],
  })] }));
  assert.equal(inline.windows[0].used_percent, 30);
  const [fallback] = await litellm.fetch(fakeContext({ env, responses: [json(key), json({
    user_info: { spend: 999 }, teams: [{ team_id: "t", max_budget: 100, spend: 20 }],
  }), json({ team_info: { team_id: "t", team_member_budget_table: { max_budget: 10 },
    team_memberships: [{ user_id: "u", spend: 4 }] } })] }));
  assert.equal(fallback.windows[0].used_percent, 40);
});

test("litellm keeps valid budgets when optional membership is unavailable or mismatched", async () => {
  for (const reply of [json({}, 404), json({ team_info: { team_id: "other" } })]) {
    const [account] = await litellm.fetch(fakeContext({ env, responses: [json({ info: { user_id: "u", team_id: "t" } }),
      json({ user_info: { spend: 999 }, teams: [{ team_id: "t", max_budget: 100, spend: 20 }] }), reply] }));
    assert.equal(account.windows[0].used_percent, 20);
    assert.equal(account.windows[1].value, "$999.00");
  }
});

test("litellm rejects mismatched mandatory identities and malformed budgets", async () => {
  for (const user of [{ user_id: "other" }, { user_id: "u", spend: "4" }]) {
    await assert.rejects(litellm.fetch(fakeContext({ env, responses: [json({ info: { user_id: "u" } }),
      json({ user_info: user })] })), HttpError);
  }
  await assert.rejects(litellm.fetch(fakeContext({ env, responses: [json({ info: { team_id: "t" } }),
    json({ team_info: { team_id: "other" } })] })), HttpError);
  await assert.rejects(litellm.fetch(fakeContext({ env, responses: [json({ info: {} })] })), HttpError);
});

test("litellm optionally aggregates flat and nested model activity across pages", async () => {
  const end = new Date(NOW * 1000).toISOString().slice(0, 10);
  const metrics = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, api_requests: 1 };
  const context = fakeContext({ env: { ...env, LITELLM_MODEL_USAGE_ENABLED: "true" }, responses: [
    json({ info: { user_id: "u" } }), json({ user_info: { user_id: "u", max_budget: 10, spend: 2 } }),
    json({ results: [{ date: end, breakdown: { models: { a: metrics } } }], metadata: { page: 1, total_pages: 2 } }),
    json({ results: [{ date: end, breakdown: { models: { a: { metrics } } } }], metadata: { page: 2, total_pages: 2 } }),
  ] });
  const [account] = await litellm.fetch(context);
  assert.equal(account.windows[0].used_percent, 20);
  assert.equal(account.windows[1].value, "60");
  assert.equal(account.windows[1].name, "tokens");
  assert.equal(new URL(context.calls[2].url).searchParams.get("page_size"), "1000");
  assert.equal(new URL(context.calls[3].url).searchParams.get("page"), "2");
});

test("litellm omits malformed or denied optional history and bounds pagination", async () => {
  for (const replies of [[json({ results: [{}] })],
    Array.from({ length: 3 }, () => json({ results: [], metadata: { has_more: true, total_pages: 4 } }))]) {
    const context = fakeContext({ env: { ...env, LITELLM_MODEL_USAGE_ENABLED: "true" }, responses: [
      json({ info: { user_id: "u" } }), json({ user_info: { max_budget: 10, spend: 2 } }), ...replies,
    ] });
    const [account] = await litellm.fetch(context);
    assert.equal(account.windows[0].used_percent, 20);
    assert.equal(account.windows.length, 1);
    assert.ok(context.calls.length <= 5);
  }
});

test("litellm surfaces denied optional history as sign in", async () => {
  const [account] = await litellm.fetch(fakeContext({ env: { ...env, LITELLM_MODEL_USAGE_ENABLED: "true" }, responses: [
    json({ info: { user_id: "u" } }), json({ user_info: { max_budget: 10, spend: 2 } }), json({}, 403),
  ] }));
  assert.equal(account.error, "sign in");
});

test("litellm cannot interpret prototype keys as budget durations", async () => {
  const [account] = await litellm.fetch(fakeContext({ env, responses: [json({ info: { team_id: "t" } }),
    json({ team_info: { team_id: "t", budget_duration: "__proto__", max_budget: 10, spend: 1 } })] }));
  assert.equal(account.windows[0].minutes, null);
});
