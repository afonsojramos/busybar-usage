import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { warp } from "../src/providers/warp.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { WARP_API_KEY: "fake-warp-key" };
// CodexBar WarpUsageFetcherTests aggregate fixture, with future reset dates.
const user = {
  requestLimitInfo: {
    isUnlimited: false,
    nextRefreshTime: "2026-12-28T19:16:33.462988Z",
    requestLimit: 1500,
    requestsUsedSinceLastRefresh: 5,
  },
  bonusGrants: [{ requestCreditsGranted: 20, requestCreditsRemaining: 10, expiration: "2027-03-01T10:00:00Z" }],
  workspaces: [
    {
      bonusGrantsInfo: {
        grants: [{ requestCreditsGranted: "15", requestCreditsRemaining: "5", expiration: "2027-03-15T10:00:00Z" }],
      },
    },
  ],
};
const payload = (value: unknown = user) => ({ data: { user: { __typename: "UserOutput", user: value } } });

test("Warp fixture aggregates personal and workspace add-ons", async () => {
  const context = fakeContext({ env, responses: [json(payload())] });
  const fetch = context.fetch;
  context.fetch = async (input, init) => {
    assert.equal(init?.method, "POST");
    assert.ok(init?.signal instanceof AbortSignal);
    const body: unknown = JSON.parse(String(init?.body));
    assert.ok(typeof body === "object" && body !== null && "query" in body);
    assert.match(String(body.query), /workspaces/);
    assert.match(String(body.query), /bonusGrantsInfo/);
    return fetch(input, init);
  };
  const [account] = await warp.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.minutes, w.used_percent]),
    [
      ["credits", null, 0],
      ["add-on", null, 57],
    ],
  );
  assert.equal(account.windows[0].resets_at, Math.floor(Date.parse(user.requestLimitInfo.nextRefreshTime) / 1000));
  assert.equal(account.windows[1].resets_at, null);
  assert.equal(context.calls[0].url, "https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-warp-key");
  assert.equal(context.calls[0].headers["user-agent"], "Warp/1.0");
  assert.equal(context.calls[0].headers["x-warp-client-id"], "warp-app");
});

test("Warp supports string numerics and no bonus window", async () => {
  const [account] = await warp.fetch(
    fakeContext({
      env,
      responses: [
        json(
          payload({
            requestLimitInfo: { isUnlimited: null, requestLimit: "100", requestsUsedSinceLastRefresh: "25" },
          }),
        ),
      ],
    }),
  );
  assert.equal(account.windows.length, 1);
  assert.equal(account.windows[0].used_percent, 25);
});

test("Warp unlimited values omit reset dates", async () => {
  for (const isUnlimited of [true, 1, "true", "YES", "1"]) {
    const [account] = await warp.fetch(
      fakeContext({
        env,
        responses: [
          json(
            payload({
              requestLimitInfo: { isUnlimited, nextRefreshTime: "2026-12-01T00:00:00Z" },
            }),
          ),
        ],
      }),
    );
    assert.equal(account.windows[0].value, "Unlimited");
    assert.equal(account.windows[0].used_percent, null);
    assert.equal(account.windows[0].resets_at, null);
  }
});

test("Warp spent pools block and remaining-only add-ons show a value", async () => {
  const [spent] = await warp.fetch(
    fakeContext({
      env,
      responses: [
        json(
          payload({
            requestLimitInfo: { requestLimit: 100, requestsUsedSinceLastRefresh: 100 },
            bonusGrants: [{ requestCreditsGranted: 20, requestCreditsRemaining: 0 }],
          }),
        ),
      ],
    }),
  );
  assert.equal(spent.blocked, true);
  assert.equal(spent.windows[1].used_percent, 100);
  const [remaining] = await warp.fetch(
    fakeContext({
      env,
      responses: [
        json(
          payload({
            requestLimitInfo: { requestLimit: 100, requestsUsedSinceLastRefresh: 1 },
            bonusGrants: [{ requestCreditsRemaining: 1200 }],
          }),
        ),
      ],
    }),
  );
  assert.equal(remaining.windows[1].value, "1.20k cr");
});

test("Warp uses API key priority and config fallback", async () => {
  for (const options of [
    { env: { WARP_API_KEY: "first", WARP_TOKEN: "second" } },
    { env: { WARP_TOKEN: "first" } },
    {
      files: {
        "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { warp: { apiKey: "first" } } }),
      },
    },
  ]) {
    const context = fakeContext({ ...options, responses: [json(payload())] });
    await warp.fetch(context);
    assert.equal(context.calls[0].headers.authorization, "Bearer first");
  }
});

test("Warp missing key is not configured", async () => {
  await assert.rejects(warp.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`Warp ${status} asks to sign in`, async () => {
    assert.equal((await warp.fetch(fakeContext({ env, responses: [json({}, status)] })))[0].error, "sign in");
  });
for (const seconds of [null, "120"])
  test(`Warp rate limit ${seconds}`, async () => {
    await assert.rejects(
      warp.fetch(fakeContext({ env, responses: [json({}, 429, seconds ? { "retry-after": seconds } : {})] })),
      (error: unknown) => error instanceof RateLimited && error.until === NOW + (seconds ? 120 : 300),
    );
  });
for (const response of [
  json({}, 500),
  new Response("fake-secret-invalid-json"),
  json({}),
  json({ errors: [{ message: "fake-secret" }] }),
  json({ data: { user: { __typename: "AuthError" } } }),
  json(payload({})),
  json(payload({ requestLimitInfo: {} })),
]) {
  test("Warp invalid responses raise sanitized HttpError", async () => {
    await assert.rejects(
      warp.fetch(fakeContext({ env, responses: [response] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("fake-secret"),
    );
  });
}
