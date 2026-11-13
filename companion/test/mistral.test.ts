import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mistral } from "../src/providers/mistral.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";
const files = (cookieHeader = "ory_session_test=fake; csrftoken=csrf; unrelated=private") => ({
  "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { mistral: { cookieHeader } } }),
});
const entry = {
  event_type: "api_tokens",
  billing_metric: "fixture",
  billing_group: "input",
  value: 100,
  value_paid: 40,
  api_zone: "global",
  service_tier: "standard",
};
const billing = {
  completion: { models: { fixture: { input: [entry] } } },
  currency: "EUR",
  prices: [{ event_type: "api_tokens", billing_metric: "fixture", billing_group: "input", price: "0.25" }],
};
const credits = { wallet_amount: 20, credit_notes_amount: 5, ongoing_usage_balance: 2, currency: "EUR" };
function flight(budget: unknown) {
  return new Response(
    `<script>self.__next_f.push(${JSON.stringify([1, `7:${JSON.stringify(["$", null, null, { budget }])}\n`])})</script>`,
  );
}
const api = { usage_percentage: 2, initial_budget: 25.5, currency: "eur", reset_at: "2026-12-01T00:00:00Z" };
test("Mistral maps CodexBar subscription budgets and billing headers", async () => {
  const context = fakeContext({
    files: files(),
    responses: [
      json(billing),
      flight({ api_budget: api, vibe_budget: { ...api, usage_percentage: 30 } }),
      json(credits),
    ],
  });
  const [account] = await mistral.fetch(context);
  assert.deepEqual(
    account?.windows.map((lane) => lane.used_percent),
    [2, 30],
  );
  assert.deepEqual(
    account?.windows.map((lane) => lane.minutes),
    [43200, 43200],
  );
  assert.equal(context.calls[0]?.headers["x-csrftoken"], "csrf");
  assert.match(context.calls[0]?.url ?? "", /month=11&year=2026$/);
});
test("Mistral computes paid spend with unqualified pricing and credits", async () => {
  const context = fakeContext({
    files: files("ory_session_test=fake"),
    responses: [json(billing), new Response("no plan"), json(credits)],
  });
  const [account] = await mistral.fetch(context);
  assert.equal(account?.windows[0]?.value, "€10.00");
  assert.equal(account?.windows[1]?.value, "€23.00");
});
test("Mistral console Vibe fallback forwards only session and csrf cookies", async () => {
  const context = fakeContext({
    files: files(),
    responses: [
      json(billing),
      flight({ api_budget: api }),
      json([{ result: { data: { json: { usage_percentage: 70, reset_at: "2026-12-01T00:00:00Z" } } } }]),
      json(credits),
    ],
  });
  const [account] = await mistral.fetch(context);
  assert.equal(account?.windows[1]?.used_percent, 70);
  assert.equal(context.calls[2]?.headers.cookie, "csrftoken=csrf; ory_session_test=fake");
  assert.equal(context.calls[2]?.headers.origin, undefined);
});
test("Mistral missing credentials", async () => {
  await assert.rejects(mistral.fetch(fakeContext({})), NotConfigured);
});
for (const status of [401, 403])
  test(`Mistral ${status} signs in`, async () => {
    assert.equal(
      (await mistral.fetch(fakeContext({ files: files(), responses: [json({}, status)] })))[0]?.error,
      "sign in",
    );
  });
test("Mistral login redirect signs in", async () => {
  const response = new Response(null, {
    status: 302,
    headers: { location: "https://auth.mistral.ai/self-service/login/browser" },
  });
  assert.equal((await mistral.fetch(fakeContext({ files: files(), responses: [response] })))[0]?.error, "sign in");
});
test("Mistral rate limit", async () => {
  await assert.rejects(
    mistral.fetch(fakeContext({ files: files(), responses: [json({}, 429)] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300,
  );
});
test("Mistral rejects malformed JSON or billing counters", async () => {
  for (const response of [new Response("private"), json({ completion: { models: [] } }), json({}, 500)]) {
    await assert.rejects(mistral.fetch(fakeContext({ files: files(), responses: [response] })), HttpError);
  }
});
test("Mistral optional failures retain required billing data", async () => {
  const context = fakeContext({
    files: files(),
    responses: [json(billing), json({}, 500), json({}, 401), json({}, 429)],
  });
  assert.equal((await mistral.fetch(context))[0]?.windows[0]?.value, "€10.00");
});
test("Mistral matches zone tier and event before legacy price fallback", async () => {
  const prices = [
    ...billing.prices,
    { ...entry, price: "0.5" },
    { ...entry, event_type: "api_audio_seconds", price: "100" },
  ];
  const context = fakeContext({
    files: files("ory_session_test=fake"),
    responses: [json({ ...billing, prices }), new Response(""), json({}, 500)],
  });
  assert.equal((await mistral.fetch(context))[0]?.windows[0]?.value, "€20.00");
});
test("Mistral skips length-delimited Flight text containing fake budgets", async () => {
  const fake = `7:${JSON.stringify({ budget: { api_budget: { ...api, usage_percentage: 99 } } })}\n`;
  const actual = `8:${JSON.stringify({ budget: { api_budget: api, vibe_budget: api } })}\n`;
  const chunk = `1:T${Buffer.byteLength(fake).toString(16)},${fake}${actual}`;
  const page = new Response(`<script>self.__next_f.push(${JSON.stringify([1, chunk])})</script>`);
  const context = fakeContext({ files: files(), responses: [json(billing), page, json(credits)] });
  assert.equal((await mistral.fetch(context))[0]?.windows[0]?.used_percent, 2);
});
