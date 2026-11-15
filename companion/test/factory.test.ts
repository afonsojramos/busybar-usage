import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { factory, parseBilling, parseLegacy } from "../src/providers/factory.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { FACTORY_API_KEY: "fake-api-key" };
const auth = { organization: { name: "Acme" }, userProfile: { id: "user-1", email: "fake@example.com" } };
const billing = {
  usesTokenRateLimitsBilling: true,
  limits: {
    standard: {
      fiveHour: { usedPercent: 32, secondsRemaining: 600 },
      weekly: { usedPercent: 74, windowEnd: (NOW + 10000) * 1000 },
      monthly: { usedPercent: 90 },
    },
  },
};
test("Factory maps CodexBar billing limits and auth fixtures", async () => {
  const context = fakeContext({ env, responses: [json(auth), json(billing)] });
  const [account] = await factory.fetch(context);
  assert.deepEqual(
    account?.windows.map((w) => [w.name, w.used_percent, w.resets_at]),
    [
      ["5h", 32, NOW + 600],
      ["7d", 74, NOW + 10000],
    ],
  );
  assert.equal(account?.account, "example");
  assert.deepEqual(
    context.calls.map((c) => c.url),
    ["https://api.factory.ai/api/app/auth/me", "https://api.factory.ai/api/billing/limits"],
  );
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-api-key");
  assert.equal(context.calls[0]?.headers["x-factory-client"], "web-app");
});
test("Factory missing key and session", async () => {
  await assert.rejects(factory.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`Factory ${status} signs in after host fallback`, async () => {
    assert.equal(
      (await factory.fetch(fakeContext({ env, responses: [json({}, status), json({}, status)] })))[0]?.error,
      "sign in",
    );
  });
test("Factory 429 honors Retry-After without fallback", async () => {
  const context = fakeContext({ env, responses: [json({}, 429, { "retry-after": "10" })] });
  await assert.rejects(factory.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 10);
  assert.equal(context.calls.length, 1);
});
test("Factory malformed auth and usage bodies are HttpError", async () => {
  await assert.rejects(
    factory.fetch(fakeContext({ env, responses: [new Response("invalid"), new Response("invalid")] })),
    HttpError,
  );
  await assert.rejects(
    factory.fetch(fakeContext({ env, responses: [json(auth), json({}), json({}), json(auth), json({}), json({})] })),
    HttpError,
  );
});
test("Factory legacy standard and premium lanes", async () => {
  const fixture = {
    usage: {
      endDate: (NOW + 1000) * 1000,
      standard: { userTokens: 100, totalAllowance: 1000, usedRatio: 0 },
      premium: { userTokens: 999, totalAllowance: 1000, usedRatio: 0.5 },
    },
  };
  const context = fakeContext({ env, responses: [json(auth), json({}, 404), json(fixture)] });
  assert.deepEqual(
    (await factory.fetch(context))[0]?.windows.map((w) => [w.name, w.used_percent]),
    [
      ["std", 10],
      ["prem", 50],
    ],
  );
  assert.equal(
    context.calls[2]?.url,
    "https://api.factory.ai/api/organization/subscription/usage?useCache=true&userId=user-1",
  );
});
test("Factory dotenv fallback", async () => {
  const context = fakeContext({
    files: { "/home/test/.factory/.env": "# comment\nexport FACTORY_API_KEY='fake-dotenv'\n" },
    responses: [json(auth), json(billing)],
  });
  await factory.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-dotenv");
});
test("Factory manually supplied cookies and bearer", async () => {
  for (const [raw, expected] of [
    ["Cookie: session=fake-cookie; access-token=fake-access", "Bearer fake-access"],
    ["Authorization: Bearer fake-manual", "Bearer fake-manual"],
  ]) {
    const context = fakeContext({
      files: {
        "/home/test/.config/busybar-usage/config.json": JSON.stringify({
          providers: { factory: { cookieSource: "manual", cookieHeader: raw } },
        }),
      },
      responses: [json(auth), json(billing)],
    });
    await factory.fetch(context);
    assert.equal(context.calls[0]?.headers.authorization, expected);
  }
});
test("Factory stored sessions before browser source", async () => {
  const context = fakeContext({
    files: {
      "/home/test/Library/Application Support/CodexBar/factory-session.json": JSON.stringify({
        cookies: [{ Name: "session", Value: "fake-stored", Domain: "app.factory.ai" }],
        refreshToken: "never-refresh",
      }),
    },
    responses: [json(auth), json(billing)],
  });
  await factory.fetch(context);
  assert.equal(context.calls[0]?.headers.cookie, "session=fake-stored");
  assert.equal(context.calls.length, 2);
});
test("Factory validates own baseURL before sending credentials", async () => {
  await assert.rejects(
    factory.fetch(
      fakeContext({
        env,
        files: {
          "/home/test/.config/busybar-usage/config.json": JSON.stringify({
            providers: { factory: { baseURL: "https://evil.example" } },
          }),
        },
      }),
    ),
    NotConfigured,
  );
});
test("Factory stale windows reset and legacy ratios retain CodexBar semantics", () => {
  assert.equal(
    parseBilling(
      {
        ...billing,
        limits: { standard: { fiveHour: { usedPercent: 99, windowEnd: NOW - 1 }, weekly: { usedPercent: 10 } } },
      },
      NOW,
    )?.[0]?.used_percent,
    0,
  );
  assert.deepEqual(
    parseLegacy(
      {
        usage: {
          standard: { totalAllowance: 1e13, usedRatio: 25 },
          premium: { userTokens: 20000000, totalAllowance: 1e13 },
        },
      },
      NOW,
    )?.map((w) => w.used_percent),
    [25, 20],
  );
  assert.equal(parseBilling({}, NOW), null);
  assert.equal(parseLegacy({}, NOW), null);
});

test("Factory empty manual credentials do not import browser cookies", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { factory: { cookieSource: "manual", cookieHeader: " " } },
      }),
    },
  });
  let browserRead = false;
  context.listDir = async () => {
    browserRead = true;
    return [];
  };
  await assert.rejects(factory.fetch(context), NotConfigured);
  assert.equal(browserRead, false);
});

test("Factory tries auth host first for auth-domain stored cookies", async () => {
  const context = fakeContext({
    files: {
      "/home/test/Library/Application Support/CodexBar/factory-session.json": JSON.stringify({
        cookies: [{ Name: "session", Value: "fake-auth-host", Domain: "auth.factory.ai" }],
      }),
    },
    responses: [json(auth), json(billing)],
  });
  await factory.fetch(context);
  assert.equal(context.calls[0]?.url, "https://auth.factory.ai/api/app/auth/me");
});

test("Factory reads Safari SQLite WorkOS access token without refreshing", async () => {
  const root = "/home/test/Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default";
  const directory = `${root}/fake-origin`;
  const db = `${directory}/LocalStorage/localstorage.sqlite3`;
  const context = fakeContext({
    platform: "darwin",
    dirs: { [root]: ["fake-origin"], [directory]: ["origin", "LocalStorage"] },
    files: { [`${directory}/origin`]: "https://app.factory.ai" },
    sqlite: {
      [`${db}::SELECT name FROM sqlite_master WHERE type='table'`]: [{ name: "ItemTable" }],
      [`${db}::SELECT value FROM ItemTable WHERE key = ? LIMIT 1`]: [
        { value: Buffer.from("fake-safari-access", "utf16le") },
      ],
    },
    responses: [json(auth), json(billing)],
  });
  await factory.fetch(context);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-safari-access");
  assert.equal(context.calls.length, 2);
});

test("Factory retries valid cookies without a rejected bearer", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: { factory: { cookieSource: "manual", cookieHeader: "session=fake-valid; access-token=fake-stale" } },
      }),
    },
    responses: [json({}, 401), json(auth), json(billing)],
  });
  assert.equal((await factory.fetch(context))[0]?.windows[0]?.used_percent, 32);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer fake-stale");
  assert.equal(context.calls[1]?.headers.authorization, undefined);
  assert.equal(context.calls[1]?.headers.cookie, "session=fake-valid; access-token=fake-stale");
});

test("Factory drops stale access cookies after conflict", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: {
          factory: {
            cookieSource: "manual",
            cookieHeader: "session=fake-valid; access-token=fake-stale; __recent_auth=fake",
          },
        },
      }),
    },
    responses: [json({}, 409), json({}, 409), json(auth), json(billing)],
  });
  assert.equal((await factory.fetch(context))[0]?.windows[0]?.used_percent, 32);
  assert.equal(context.calls[2]?.headers.cookie, "session=fake-valid");
  assert.equal(context.calls[2]?.headers.authorization, undefined);
  assert.equal(context.calls.length, 4);
});

test("Factory exhausted conflict retries retain authentication rejection", async () => {
  const responses = [0, 1, 2].flatMap(() => [json({}, 409), json({}, 401), json({}, 401), json({}, 401)]);
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: {
          factory: { cookieSource: "manual", cookieHeader: "session=fake-expired; access-token=fake-stale" },
        },
      }),
    },
    responses,
  });
  assert.equal((await factory.fetch(context))[0]?.error, "sign in");
  assert.equal(context.calls.length, 12);
});

test("Factory conflict retry rate limit stops all further attempts", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({
        providers: {
          factory: { cookieSource: "manual", cookieHeader: "session=fake-expired; access-token=fake-stale" },
        },
      }),
    },
    responses: [json({}, 409), json({}, 429, { "retry-after": "11" })],
  });
  await assert.rejects(factory.fetch(context), (e: unknown) => e instanceof RateLimited && e.until === NOW + 11);
  assert.equal(context.calls.length, 2);
});
