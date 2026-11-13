import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { t3chat } from "../src/providers/t3chat.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const files = (cookieHeader = "session=fixture", cookieSource = "manual") => ({
  "/home/test/.config/busybar-usage/config.json": JSON.stringify({
    providers: { t3chat: { cookieSource, cookieHeader } },
  }),
});
// T3ChatUsageFetcherTests JSONL graph, with reset dates moved beyond the test clock.
const customer = {
  subTier: "pro",
  usageBand: "max",
  subscription: { productName: "pro", status: "active", currentPeriodEnd: (NOW + 86400 * 30) * 1000 },
  usageFourHourPercentage: 12.5,
  usageMonthPercentage: 34.25,
  usageFourHourNextResetAt: (NOW + 14400) * 1000,
  usagePeriodPercentage: 44,
};
const body = (data: unknown = customer) =>
  new Response(
    [
      '{"json":{"0":[[0],[null,0,0]]}}',
      '{"json":[0,0,[[{"result":0}],["result",0,1]]]}',
      JSON.stringify({ json: [2, 0, [[data]]] }),
    ].join("\n"),
  );

test("T3 Chat parses JSONL and sends tRPC request", async () => {
  const context = fakeContext({ files: files(), responses: [body()] });
  const [account] = await t3chat.fetch(context);
  assert.deepEqual(
    account.windows.map((w) => [w.name, w.used_percent, w.resets_at]),
    [
      ["4h", 13, NOW + 14400],
      ["30d", 34, NOW + 86400 * 30],
    ],
  );
  const url = new URL(context.calls[0].url);
  assert.equal(url.origin, "https://t3.chat");
  assert.equal(url.pathname, "/api/trpc/getCustomerData");
  assert.equal(url.searchParams.get("batch"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("input") ?? ""), {
    0: {
      json: { sessionId: null },
      meta: { values: { sessionId: ["undefined"] } },
    },
  });
  assert.equal(context.calls[0].headers.cookie, "session=fixture");
  assert.equal(context.calls[0].headers["trpc-accept"], "application/jsonl");
});

test("T3 Chat accepts cURL captures as data and forwards only allowed headers", async () => {
  const capture = `curl 'https://evil.test/ignored' --header "Cookie: session=fixture; cf_clearance=fake" \\\n    -H 'X-Deployment-Id: dpl_fixture' -H 'Authorization: secret' -H 'Origin: https://evil.test'`;
  const context = fakeContext({ files: files(capture), responses: [body()] });
  await t3chat.fetch(context);
  assert.equal(context.calls[0].headers.cookie, "session=fixture; cf_clearance=fake");
  assert.equal(context.calls[0].headers["x-deployment-id"], "dpl_fixture");
  assert.equal(context.calls[0].headers.origin, "https://t3.chat");
  assert.equal(context.calls[0].headers.authorization, undefined);
});

test("T3 Chat fallbacks use period percentage and rolling reset, ignoring billing reset", async () => {
  const [account] = await t3chat.fetch(
    fakeContext({
      files: files(),
      responses: [
        body({
          usageFourHourPercentage: 100,
          usagePeriodPercentage: 65,
          usageFourHourNextResetAt: -1,
          usageWindowNextResetAt: NOW + 3600,
          billingNextResetAt: (NOW + 123) * 1000,
        }),
      ],
    }),
  );
  assert.deepEqual(
    account.windows.map((w) => [w.used_percent, w.resets_at]),
    [
      [100, NOW + 3600],
      [65, null],
    ],
  );
  assert.equal(account.blocked, true);
});

test("T3 Chat no session, disabled source and capture without cookie are not configured", async () => {
  for (const context of [
    fakeContext({}),
    fakeContext({ files: files("session=fixture", "off") }),
    fakeContext({ files: files("curl 'https://t3.chat' -H 'Accept: */*'") }),
  ]) {
    await assert.rejects(t3chat.fetch(context), NotConfigured);
  }
});

for (const status of [401, 403]) {
  test(`T3 Chat ${status} asks to sign in`, async () => {
    assert.equal(
      (await t3chat.fetch(fakeContext({ files: files(), responses: [json({}, status)] })))[0].error,
      "sign in",
    );
  });
}

test("T3 Chat 429 challenge respects retry header", async () => {
  await assert.rejects(
    t3chat.fetch(
      fakeContext({
        files: files(),
        responses: [json({}, 429, { "retry-after": "33", "x-vercel-mitigated": "challenge" })],
      }),
    ),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 33,
  );
});

for (const data of [
  {},
  { usageFourHourPercentage: "25" },
  { usageMonthPercentage: 25, subscription: [] },
  { usageFourHourPercentage: 25, subscription: { currentPeriodEnd: "bad" } },
  { usageFourHourPercentage: 25, usageBand: 2 },
]) {
  test(`T3 Chat rejects invalid customer data ${JSON.stringify(data)}`, async () => {
    await assert.rejects(t3chat.fetch(fakeContext({ files: files(), responses: [body(data)] })), HttpError);
  });
}

test("T3 Chat invalid JSON and server errors use HttpError", async () => {
  for (const response of [new Response("secret"), json({}, 500)]) {
    await assert.rejects(t3chat.fetch(fakeContext({ files: files(), responses: [response] })), HttpError);
  }
});

test("T3 Chat parses attached, ANSI-C and bare cURL header arguments", async () => {
  const capture =
    "curl 'https://t3.chat' -H$'Cookie: session=fixture' --header=X-Deployment-Id:dpl_test -H'Accept: */*'";
  const context = fakeContext({ files: files(capture), responses: [body()] });
  await t3chat.fetch(context);
  assert.equal(context.calls[0].headers.cookie, "session=fixture");
  assert.equal(context.calls[0].headers["x-deployment-id"], "dpl_test");
});

test("T3 Chat empty manual field never imports browser cookies", async () => {
  const context = fakeContext({ files: files("") });
  context.querySqlite = async () => {
    throw new Error("manual must not import");
  };
  await assert.rejects(t3chat.fetch(context), NotConfigured);
});
