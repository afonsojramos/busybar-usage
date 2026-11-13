import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { groq, parseScalar } from "../src/providers/groq.ts";
import { NotConfigured, RateLimited, HttpError } from "../src/providers/types.ts";
import { fakeContext, json, jwt, NOW } from "./helpers.ts";

const session = jwt({ "https://groq.com/organization": { id: "org_fixture" }, email: "user@example.com" });
const env = { GROQ_SESSION_JWT: session };
const activity = { object: "list", data: [
  { organization_name: "Personal", model: "llama-3.1-8b-instant", timestamp: NOW, num_requests: 3, n_context_tokens_total: 100, n_non_cached_context_tokens_total: 80, n_generated_tokens_total: 40, cost: 0.01 },
  { model: "openai/gpt-oss-120b", timestamp: NOW, num_requests: 2, n_context_tokens_total: 50, n_generated_tokens_total: 10, cost: 0.02 },
] };
const scalar = (v: unknown) => ({ status: "success", data: { result: [{ value: [NOW, v] }] } });
test("Groq aggregates CodexBar console activity fixture", async () => {
  const c = fakeContext({ env, responses: [json(activity)] });
  const [a] = await groq.fetch(c);
  assert.equal(a?.account, "example");
  assert.deepEqual(a?.windows.map((w) => w.value), ["$0.03", "200 tok"]);
  assert.equal(c.calls[0]?.headers.authorization, `Bearer ${session}`);
  assert.match(c.calls[0]?.url ?? "", /platform\/v1\/organizations\/org_fixture\/activity\?start_date=/);
});
test("Groq has no credentials", async () => { await assert.rejects(groq.fetch(fakeContext({})), NotConfigured); });
for (const status of [401, 403]) test(`Groq ${status} needs sign in`, async () => {
  assert.equal((await groq.fetch(fakeContext({ env, responses: [json({}, status)] })))[0]?.error, "sign in");
});
test("Groq honors retry-after", async () => {
  await assert.rejects(groq.fetch(fakeContext({ env, responses: [json({}, 429, { "retry-after": "7" })] })), (e: unknown) => e instanceof RateLimited && e.until === NOW + 7);
});
test("Groq rejects malformed responses", async () => {
  for (const response of [json({ data: [{}] }), json({}), new Response("fake-secret"), json({}, 500)]) await assert.rejects(groq.fetch(fakeContext({ env, responses: [response] })), HttpError);
});
test("Groq exchanges opaque session with Stytch without persisting it", async () => {
  const c = fakeContext({ env: { GROQ_SESSION_TOKEN: "fake-opaque" }, responses: [json({ data: { session_jwt: session } }), json(activity)] });
  await groq.fetch(c);
  assert.equal(c.calls[0]?.url, "https://api.stytchb2b.groq.com/sdk/v1/b2b/sessions/authenticate");
  assert.match(c.calls[0]?.headers.authorization ?? "", /^Basic /);
  assert.equal(c.calls[0]?.headers.origin, "https://console.groq.com");
  assert.equal(c.calls[1]?.headers.authorization, `Bearer ${session}`);
});
test("Groq falls back to direct JWT when session exchange fails", async () => {
  const c = fakeContext({ env: { ...env, GROQ_SESSION_TOKEN: "fake-opaque" }, responses: [json({}, 401), json(activity)] });
  assert.equal((await groq.fetch(c))[0]?.windows[0]?.value, "$0.03");
});
test("Groq rejects overrides before disclosing credentials", async () => {
  for (const override of ["https://evil.example", "http://api.groq.com", "https://user:pass@api.groq.com"]) {
    const c = fakeContext({ env: { ...env, GROQ_API_URL: override } });
    await assert.rejects(groq.fetch(c), NotConfigured); assert.equal(c.calls.length, 0);
  }
  const c = fakeContext({ env: { GROQ_SESSION_TOKEN: "fake-opaque", GROQ_STYTCH_URL: "https://evil.example" } });
  await assert.rejects(groq.fetch(c), NotConfigured); assert.equal(c.calls.length, 0);
});
test("Groq metrics fallback maps request and token rates without invented limits", async () => {
  const c = fakeContext({ env: { GROQ_API_KEY: "fake-key" }, responses: [json(scalar("2")), json(scalar("3")), json(scalar("4")), json(scalar("1"))] });
  const [a] = await groq.fetch(c);
  assert.deepEqual(a?.windows.map((w) => w.value), ["120", "420"]);
  assert.equal(c.calls.length, 4);
  assert.match(c.calls[0]?.url ?? "", /\/v1\/metrics\/prometheus\/api\/v1\/query\?query=/);
});
test("Groq scalar parsing handles empty series and rejects invalid samples", () => {
  assert.equal(parseScalar({ status: "success", data: { result: [] } }), 0);
  for (const v of ["NaN", "-1", "Infinity"]) assert.throws(() => parseScalar(scalar(v)), HttpError);
  assert.throws(() => parseScalar({ status: "error", error: "fake-secret" }), HttpError);
});
test("Groq falls back to Enterprise metrics after console authentication rejection", async () => {
  const c = fakeContext({ env: { ...env, GROQ_API_KEY: "fake-key" }, responses: [json({}, 401), ...[1, 2, 3, 4].map((n) => json(scalar(n)))] });
  assert.equal((await groq.fetch(c))[0]?.windows[0]?.name, "Req/min");
});
test("Groq bounds large finite value strings", async () => {
  const c = fakeContext({ env, responses: [json({ data: [{ timestamp: NOW, cost: 1e100, n_context_tokens_total: 1e200 }] })] });
  for (const lane of (await groq.fetch(c))[0]?.windows ?? []) assert.ok((lane.value?.length ?? 0) <= 12);
});
