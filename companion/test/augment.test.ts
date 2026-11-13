import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { augment } from "../src/providers/augment.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

// Derived from CodexBar's augment parser/fetcher fixtures, with fake identity and future resets.
const fixture = { usageUnitsRemaining: 750, usageUnitsConsumedThisBillingCycle: 250, usageUnitsAvailable: 1000 };
const configured = {
  files: {
    "/home/test/.config/busybar-usage/config.json": JSON.stringify({
      providers: { augment: { cookieHeader: "session=fake" } },
    }),
  },
};

test("augment: parses CodexBar-derived fixture", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json(fixture), json({ billingPeriodEnd: "2027-01-01T00:00:00Z", email: "test@example.com" })],
  });
  const [account] = await augment.fetch(context);
  assert.equal(account.provider, "augment");
  assert.equal(account.windows[0].used_percent, 25);
  assert.ok(account.windows.length <= 2);
  assert.ok(context.calls.every((call) => call.url.startsWith("https://")));
});
test("augment: missing credentials", async () => {
  await assert.rejects(augment.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`augment: ${status} asks to sign in`, async () => {
    const [account] = await augment.fetch(fakeContext({ ...configured, responses: [json({}, status)] }));
    assert.equal(account.error, "sign in");
  });
test("augment: rate limit honors Retry-After", async () => {
  await assert.rejects(
    augment.fetch(fakeContext({ ...configured, responses: [json({}, 429, { "retry-after": "120" })] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 120,
  );
});
for (const response of [new Response("not json"), json({}), json({ secret: "never echo" }, 500)]) {
  test(`augment: invalid response ${response.status} is a sanitized HttpError`, async () => {
    await assert.rejects(
      augment.fetch(fakeContext({ ...configured, responses: [response] })),
      (error: unknown) => error instanceof HttpError && !error.message.includes("never echo"),
    );
  });
}

test("Augment: current CLI report precedes cookies", async () => {
  const context = fakeContext({
    ...configured,
    commands: {
      "auggie account status": {
        code: 0,
        stderr: "",
        stdout:
          "319,054 credits remaining Max Plan\n450,000 credits / month\n9 days remaining in this billing cycle (ends 1/9/2027)",
      },
    },
  });
  assert.equal((await augment.fetch(context))[0].windows[0].used_percent, 29);
  assert.equal(context.calls.length, 0);
});
test("Augment: legacy CLI total includes credit additions", async () => {
  const context = fakeContext({
    commands: {
      "auggie account status": {
        code: 0,
        stderr: "",
        stdout:
          "Max Plan 450,000 credits / month\n11,657 remaining · 953,170 / 964,827 credits used\n2 days remaining in this billing cycle (ends 1/8/2027)",
      },
    },
  });
  assert.equal((await augment.fetch(context))[0].windows[0].used_percent, 99);
});
test("Augment: missing allowance derives total from remaining plus consumed", async () => {
  const context = fakeContext({
    ...configured,
    responses: [json({ usageUnitsRemaining: 750, usageUnitsConsumedThisBillingCycle: 250 }), json({})],
  });
  assert.equal((await augment.fetch(context))[0].windows[0].used_percent, 25);
});
test("Augment: subscription rejection asks to sign in", async () => {
  const context = fakeContext({ ...configured, responses: [json(fixture), json({}, 401)] });
  assert.equal((await augment.fetch(context))[0].error, "sign in");
});
