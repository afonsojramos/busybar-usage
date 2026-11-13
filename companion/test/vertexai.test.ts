import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vite-plus/test";
import { vertexai, quotaPercent } from "../src/providers/vertexai.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, jwt, NOW } from "./helpers.ts";

const adc = "/home/test/.config/gcloud/application_default_credentials.json";
const credentials = {
  client_id: "fake-client",
  client_secret: "fake-secret",
  refresh_token: "fake-refresh",
  access_token: "fake-access",
  token_expiry: new Date((NOW + 3600) * 1000).toISOString(),
  id_token: jwt({ email: "fixture@example.test" }),
};
const files = { [adc]: JSON.stringify(credentials) };
const env = { GOOGLE_CLOUD_PROJECT: "fixture-project" };
const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`./fixtures/vertexai/${name}.json`, import.meta.url), "utf8"));
const usage = await fixture("exact-named-usage");
const limits = await fixture("exact-named-limits");

test("Vertex AI ports exact-named CodexBar quota fixtures and request parameters", async () => {
  const context = fakeContext({ files, env, responses: [json(usage), json(limits)] });
  const [account] = await vertexai.fetch(context);
  assert.equal(account.account, "example");
  assert.equal(account.windows[0].used_percent, 25);
  assert.equal(account.windows[0].name, "quota");
  assert.equal(account.windows[0].minutes, null);
  const url = new URL(context.calls[0].url);
  assert.equal(url.origin, "https://monitoring.googleapis.com");
  assert.equal(url.pathname, "/v3/projects/fixture-project/timeSeries");
  assert.match(url.searchParams.get("filter") ?? "", /quota\/allocation\/usage/);
  assert.equal(url.searchParams.get("aggregation.perSeriesAligner"), "ALIGN_MAX");
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-access");
});

test("Vertex AI matches unnamed quota only to an unambiguous limit in the same region", async () => {
  const unnamed = await fixture("issue-2958-usage-without-limit-name");
  assert.equal(
    quotaPercent(unnamed.timeSeries, (await fixture("issue-2958-regional-and-global-limits")).timeSeries),
    1,
  );
  assert.equal(quotaPercent(unnamed.timeSeries, (await fixture("ambiguous-regional-limits")).timeSeries), null);
});

test("Vertex AI requires credentials and a project", async () => {
  await assert.rejects(vertexai.fetch(fakeContext({})), NotConfigured);
  await assert.rejects(vertexai.fetch(fakeContext({ files })), NotConfigured);
});

for (const status of [401, 403, 429, 500]) {
  test(`Vertex AI handles HTTP ${status}`, async () => {
    const context = fakeContext({ files, env, responses: [json({}, status, { "retry-after": "120" })] });
    if (status === 401 || status === 403) assert.equal((await vertexai.fetch(context))[0].error, "sign in");
    else if (status === 429)
      await assert.rejects(
        vertexai.fetch(context),
        (error: unknown) => error instanceof RateLimited && error.until === NOW + 120,
      );
    else await assert.rejects(vertexai.fetch(context), HttpError);
  });
}

test("Vertex AI refreshes nonrotating ADC tokens in memory using Google's fixed endpoint", async () => {
  const context = fakeContext({
    env,
    files: { [adc]: JSON.stringify({ ...credentials, access_token: "", token_expiry: null }) },
    responses: [
      json({ access_token: "fake-new", id_token: jwt({ email: "new@updated.test" }), expires_in: 3600 }),
      json(usage),
      json(limits),
    ],
  });
  const originalFetch = context.fetch;
  let form: URLSearchParams | null = null;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal);
    assert.equal(init.redirect, "error");
    if (String(input).includes("oauth2")) {
      assert.equal(init.method, "POST");
      form = new URLSearchParams(String(init.body));
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "fake-refresh");
    }
    return originalFetch(input, init);
  };
  const [account] = await vertexai.fetch(context);
  assert.equal(account.account, "updated");
  assert.equal(context.calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(context.calls[1].headers.authorization, "Bearer fake-new");
});

test("Vertex AI rejects malformed JSON and unusable refresh responses without leaking bodies", async () => {
  for (const response of [new Response("fake-secret"), json({ timeSeries: "bad" })]) {
    await assert.rejects(vertexai.fetch(fakeContext({ files, env, responses: [response] })), HttpError);
  }
  await assert.rejects(
    vertexai.fetch(
      fakeContext({
        env,
        files: { [adc]: JSON.stringify({ ...credentials, access_token: "", token_expiry: null }) },
        responses: [json({ access_token: " " })],
      }),
    ),
    HttpError,
  );
});

test("Vertex AI service account delegates token printing to gcloud and uses its project", async () => {
  const context = fakeContext({
    env: { GOOGLE_APPLICATION_CREDENTIALS: "/service.json", CLOUDSDK_CONFIG: "/gcloud" },
    files: {
      "/service.json": JSON.stringify({
        private_key: "fake-key",
        client_email: "fake@service.test",
        project_id: "service-project",
      }),
    },
    commands: {
      "gcloud auth application-default print-access-token": { code: 0, stdout: "fake-service-token\n", stderr: "" },
    },
    responses: [json(usage), json(limits)],
  });
  const [account] = await vertexai.fetch(context);
  assert.equal(account.account, "service");
  assert.match(context.calls[0].url, /service-project/);
  assert.equal(context.calls[0].headers.authorization, "Bearer fake-service-token");
  assert.deepEqual(context.runs, ["gcloud auth application-default print-access-token"]);
});

test("Vertex AI config project precedes project environment variables", async () => {
  const context = fakeContext({
    env: { ...env, CLOUDSDK_CONFIG: "/cfg" },
    files: {
      "/cfg/application_default_credentials.json": JSON.stringify(credentials),
      "/cfg/configurations/config_default": "[core]\nproject = configured-project\n",
    },
    responses: [json({}), json({})],
  });
  assert.deepEqual((await vertexai.fetch(context))[0].windows, []);
  assert.match(context.calls[0].url, /configured-project/);
});

test("Vertex AI pagination retains the repeated-cursor page, then stops", async () => {
  const context = fakeContext({
    files,
    env,
    responses: [json({ ...usage, nextPageToken: "p2" }), json({ ...usage, nextPageToken: "p2" }), json(limits)],
  });
  assert.equal((await vertexai.fetch(context))[0].windows[0].used_percent, 25);
  assert.equal(new URL(context.calls[1].url).searchParams.get("pageToken"), "p2");
  assert.equal(context.calls.length, 3);
});

test("Vertex AI bounds pagination but accepts the final page at its budget", async () => {
  const pages = Array.from({ length: 100 }, (_, index) => json({ ...usage, nextPageToken: `p${index}` }));
  const context = fakeContext({ files, env, responses: pages });
  await assert.rejects(vertexai.fetch(context), HttpError);
  assert.equal(context.calls.length, 100);
  const final = fakeContext({
    files,
    env,
    responses: [
      ...Array.from({ length: 99 }, (_, index) => json({ ...usage, nextPageToken: `p${index}` })),
      json(usage),
      json(limits),
    ],
  });
  assert.equal((await vertexai.fetch(final))[0].windows[0].used_percent, 25);
});

test("Vertex AI reads local Claude transcripts, filters providers and dates, and deduplicates messages", async () => {
  const root = "/home/test/.claude/projects";
  const row = (id: string, model: string, tokens: number, extra = {}) =>
    JSON.stringify({
      type: "assistant",
      sessionId: "fake-session",
      timestamp: new Date(NOW * 1000).toISOString(),
      message: { id, model, usage: { input_tokens: tokens, output_tokens: 100 } },
      ...extra,
    });
  const context = fakeContext({
    files: {
      ...files,
      [`${root}/project/log.jsonl`]: [
        row("msg_vrtx_1", "claude-opus", 200),
        row("msg_vrtx_1", "claude-opus", 200),
        row("2", "claude-opus@20251101", 300),
        row("3", "claude-opus", 400, { metadata: { provider: "vertexai" } }),
        row("4", "claude-opus", 900),
        row("5", "claude-opus@20251101", 900, { timestamp: "2000-01-01T00:00:00Z" }),
        "bad json",
      ].join("\n"),
    },
    env,
    dirs: { [root]: ["project"], [`${root}/project`]: ["log.jsonl"] },
    responses: [json(usage), json(limits)],
  });
  const windows = (await vertexai.fetch(context))[0].windows;
  assert.equal(windows[1].name, "30d tok");
  assert.equal(windows[1].value, "1.2K");
});

test("Vertex AI reads alternate local roots and keeps a rounded full quota blocked", async () => {
  const series = (value: number) => ({
    timeSeries: [
      {
        metric: { labels: { quota_metric: "fixture-quota" } },
        resource: {},
        points: [{ value: { doubleValue: value } }],
      },
    ],
  });
  const desktop = "/home/test/Library/Application Support/Claude/claude-code-sessions";
  const swap = "/home/test/.local/share/claude-swap/sessions";
  const row = (id: string) =>
    JSON.stringify({
      type: "assistant",
      requestId: `req-${id}`,
      timestamp: new Date(NOW * 1000).toISOString(),
      message: {
        id,
        model: "claude-opus",
        usage: { input_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 50 },
      },
      metadata: { client: "vertexai" },
    });
  const context = fakeContext({
    env,
    files: {
      ...files,
      "/home/test/.config/claude/projects/a.jsonl": row("config"),
      [`${desktop}/session/audit.jsonl`]: row("desktop"),
      [`${swap}/1-work/projects/a.jsonl`]: row("swap"),
    },
    dirs: {
      "/home/test/.config/claude/projects": ["a.jsonl"],
      [desktop]: ["session"],
      [swap]: ["1-work"],
      [`${swap}/1-work/projects`]: ["a.jsonl"],
    },
    responses: [json(series(99.5)), json(series(100))],
  });
  const [account] = await vertexai.fetch(context);
  assert.equal(account.blocked, true);
  assert.equal(account.windows[1].value, "1.2K");
});

test("Vertex AI propagates dependency and cancellation failures without rewriting credentials", async () => {
  for (const error of [
    new TypeError("fetch failed"),
    new DOMException("timeout", "TimeoutError"),
    new DOMException("cancel", "AbortError"),
  ]) {
    const context = fakeContext({ env, files });
    context.fetch = async () => {
      throw error;
    };
    await assert.rejects(vertexai.fetch(context), (received) => received === error);
  }
});

test("Vertex AI uses the default rate limit delay", async () => {
  await assert.rejects(
    vertexai.fetch(fakeContext({ env, files, responses: [json({}, 429)] })),
    (error: unknown) => error instanceof RateLimited && error.until === NOW + 300,
  );
});
