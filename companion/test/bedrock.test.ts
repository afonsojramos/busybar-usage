import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { bedrock, signedHeaders } from "../src/providers/bedrock.ts";
import { HttpError, NotConfigured, RateLimited } from "../src/providers/types.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const env = { AWS_ACCESS_KEY_ID: "fake-access", AWS_SECRET_ACCESS_KEY: "fake-secret", AWS_SESSION_TOKEN: "fake-session" };
const spend = { ResultsByTime: [{ TimePeriod: { Start: "2026-11-01", End: "2026-11-14" }, Groups: [
  { Keys: ["Amazon Bedrock"], Metrics: { UnblendedCost: { Amount: "12.50", Unit: "USD" } } },
  { Keys: ["Amazon EC2"], Metrics: { UnblendedCost: { Amount: "900.00", Unit: "USD" } } },
] }] };
const activity = { MetricDataResults: [
  { Id: "inputTokens", StatusCode: "Complete", Values: [1000, 2500] },
  { Id: "outputTokens", StatusCode: "Complete", Values: [400, 600] },
  { Id: "requests", StatusCode: "Complete", Values: [7, 8] },
] };

test("Bedrock ports CodexBar's grouped cost and CloudWatch activity fixtures", async () => {
  const context = fakeContext({ env, responses: [json(spend), json(activity)] });
  const original = context.fetch;
  context.fetch = async (input, init) => {
    assert.ok(init?.signal);
    assert.equal(init.redirect, "error");
    const payload: unknown = JSON.parse(String(init.body));
    assert.equal(init.method, "POST");
    if (String(input).includes("ce.")) assert.deepEqual(payload, {
      TimePeriod: { Start: "2026-11-01", End: new Date((NOW + 86400) * 1000).toISOString().slice(0, 10) },
      Granularity: "MONTHLY", Metrics: ["UnblendedCost"], GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    });
    else {
      assert.match(String(init.body), /claude/);
      assert.match(String(init.body), /InputTokenCount/);
      assert.match(String(init.body), /Invocations/);
    }
    return original(input, init);
  };
  const [account] = await bedrock.fetch(context);
  assert.equal(account.account, "default");
  assert.deepEqual(account.windows.map((window) => [window.name, window.value]), [["spend", "$12.50"], ["14d tok", "4.5K"]]);
  assert.equal(context.calls[0].url, "https://ce.us-east-1.amazonaws.com/");
  assert.equal(context.calls[0].headers["x-amz-target"], "AWSInsightsIndexService.GetCostAndUsage");
  assert.equal(context.calls[0].headers["x-amz-security-token"], "fake-session");
  assert.match(context.calls[0].headers.authorization, /fake-access\/\d{8}\/us-east-1\/ce\/aws4_request/);
});

test("Bedrock budget keeps monthly progress and spend, and marks exhausted budgets", async () => {
  const context = fakeContext({ env: { ...env, CODEXBAR_BEDROCK_BUDGET: "10" }, responses: [json(spend), json(activity)] });
  const [account] = await bedrock.fetch(context);
  assert.equal(account.blocked, true);
  assert.equal(account.windows.length, 2);
  assert.equal(account.windows[0].name, "month");
  assert.equal(account.windows[0].used_percent, 100);
  assert.equal(account.windows[0].resets_at, Date.UTC(2026, 11, 1) / 1000);
});

test("Bedrock requires both static credentials or a named profile", async () => {
  for (const env of [{}, { AWS_ACCESS_KEY_ID: "fake" }, { CODEXBAR_BEDROCK_AUTH_MODE: "profile" }]) {
    await assert.rejects(bedrock.fetch(fakeContext({ env })), NotConfigured);
  }
});

for (const status of [401, 403, 429, 500]) {
  test(`Bedrock handles Cost Explorer HTTP ${status}`, async () => {
    const context = fakeContext({ env, responses: [json({}, status, { "retry-after": "90" })] });
    if (status === 401 || status === 403) assert.equal((await bedrock.fetch(context))[0].error, "sign in");
    else if (status === 429) await assert.rejects(bedrock.fetch(context), (error: unknown) => error instanceof RateLimited && error.until === NOW + 90);
    else await assert.rejects(bedrock.fetch(context), HttpError);
  });
}

test("Bedrock rejects incomplete or invalid CloudWatch results", async () => {
  for (const response of [json({ MetricDataResults: [{ Id: "inputTokens", StatusCode: "PartialData", Values: [2] }] }),
    json({ Messages: [{ Code: "PartialData" }], MetricDataResults: [] }), json({ MetricDataResults: [{ Id: "inputTokens", StatusCode: "Complete", Values: [1e99] }] })]) {
    await assert.rejects(bedrock.fetch(fakeContext({ env, responses: [json(spend), response] })), HttpError);
  }
});

for (const status of [401, 403]) {
  test(`Bedrock CloudWatch HTTP ${status} asks to sign in`, async () => {
    const [account] = await bedrock.fetch(fakeContext({ env, responses: [json(spend), json({}, status)] }));
    assert.equal(account.error, "sign in");
  });
}

test("Bedrock keeps measured spend through a CloudWatch transport failure", async () => {
  const context = fakeContext({ env, responses: [json(spend)] });
  const original = context.fetch;
  context.fetch = async (input, init) => {
    if (String(input).includes("monitoring")) throw new TypeError("fetch failed");
    return original(input, init);
  };
  const [account] = await bedrock.fetch(context);
  assert.equal(account.windows[0].value, "$12.50");
  assert.equal(account.windows.length, 1);
});

test("Bedrock preserves caller cancellation", async () => {
  const context = fakeContext({ env, responses: [json(spend)] });
  const original = context.fetch;
  context.fetch = async (input, init) => {
    if (String(input).includes("monitoring")) throw new DOMException("cancelled", "AbortError");
    return original(input, init);
  };
  await assert.rejects(bedrock.fetch(context), (error: unknown) => error instanceof Error && error.name === "AbortError");
});

test("Bedrock respects CloudWatch retry budgets", async () => {
  await assert.rejects(bedrock.fetch(fakeContext({ env, responses: [json(spend), json({}, 429)] })), RateLimited);
});

test("Bedrock rejects malformed or unavailable cost instead of reporting zero", async () => {
  for (const response of [json({}), new Response("fake-secret"), json({ __type: "DataUnavailableException" }, 400),
    json({ ResultsByTime: [{ Groups: [{ Keys: ["Amazon Bedrock"], Metrics: {} }] }] })]) {
    await assert.rejects(bedrock.fetch(fakeContext({ env, responses: [response] })), HttpError);
  }
  const [zero] = await bedrock.fetch(fakeContext({ env, responses: [json({ ResultsByTime: [] }), json({ MetricDataResults: [] })] }));
  assert.equal(zero.windows[0].value, "$0.00");
});

test("Bedrock paginates cost and activity with bounded cursors", async () => {
  const context = fakeContext({ env, responses: [json({ ...spend, NextPageToken: "cost2" }), json(spend),
    json({ ...activity, NextToken: "activity2" }), json(activity)] });
  const [account] = await bedrock.fetch(context);
  assert.equal(account.windows[0].value, "$25.00");
  assert.equal(account.windows[1].value, "9K");
  assert.equal(context.calls.length, 4);
  await assert.rejects(bedrock.fetch(fakeContext({ env, responses: [json({ ...spend, NextPageToken: "again" }), json({ ...spend, NextPageToken: "again" })] })), HttpError);
});

test("Bedrock reads keys and region from the provider config", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: {
    bedrock: { apiKey: "fake-config-access", secretKey: "fake-config-secret", region: "eu-west-1" },
  } }) }, responses: [json(spend), json(activity)] });
  await bedrock.fetch(context);
  assert.match(context.calls[0].headers.authorization, /fake-config-access/);
  assert.equal(context.calls[1].url, "https://monitoring.eu-west-1.amazonaws.com/");
});

test("Bedrock resolves AWS profiles with exact CLI arguments and configured region", async () => {
  const context = fakeContext({ env: { AWS_PROFILE: "work" }, commands: {
    "aws configure export-credentials --profile work --format process": { code: 0, stdout: JSON.stringify({ Version: 1, AccessKeyId: "fake-profile", SecretAccessKey: "fake-secret", SessionToken: "fake-profile-session" }), stderr: "" },
    "aws configure get region --profile work": { code: 0, stdout: "ap-southeast-2\n", stderr: "" },
  }, responses: [json(spend), json(activity)] });
  await bedrock.fetch(context);
  assert.deepEqual(context.runs, ["aws configure export-credentials --profile work --format process", "aws configure get region --profile work"]);
  assert.equal(context.calls[1].url, "https://monitoring.ap-southeast-2.amazonaws.com/");
  assert.equal(context.calls[0].headers["x-amz-security-token"], "fake-profile-session");
});

test("Bedrock handles missing CLI, expired sessions, and invalid exported credentials", async () => {
  await assert.rejects(bedrock.fetch(fakeContext({ env: { AWS_PROFILE: "work" } })), NotConfigured);
  for (const [result, signIn] of [
    [{ code: 1, stdout: "", stderr: "SSO token expired fake-secret" }, true],
    [{ code: 0, stdout: "fake-secret", stderr: "" }, false],
  ] as const) {
    const context = fakeContext({ env: { AWS_PROFILE: "work" }, commands: { "aws configure export-credentials --profile work --format process": result } });
    if (signIn) assert.equal((await bedrock.fetch(context))[0].error, "sign in");
    else await assert.rejects(bedrock.fetch(context), HttpError);
  }
});

test("Bedrock never sends signing credentials to an unrelated override or invalid region", async () => {
  for (const override of ["https://evil.test", "http://ce.us-east-1.amazonaws.com", "https://ce.us-east-1.amazonaws.com.evil.test", "https://user@ce.us-east-1.amazonaws.com"]) {
    const context = fakeContext({ env: { ...env, CODEXBAR_BEDROCK_API_URL: override } });
    await assert.rejects(bedrock.fetch(context), NotConfigured);
    assert.equal(context.calls.length, 0);
  }
  await assert.rejects(bedrock.fetch(fakeContext({ env: { ...env, AWS_REGION: "evil.test/path" } })), NotConfigured);
});

test("Bedrock CloudWatch uses the matching AWS partition host", async () => {
  const context = fakeContext({ env: { ...env, AWS_REGION: "cn-north-1" }, responses: [json(spend), json(activity)] });
  await bedrock.fetch(context);
  assert.equal(context.calls[1].url, "https://monitoring.cn-north-1.amazonaws.com.cn/");
});

test("Bedrock SigV4 signature validates against an independently reconstructed canonical request", () => {
  const url = new URL("https://ce.us-east-1.amazonaws.com/");
  const body = "{}";
  const headers = signedHeaders(url, body, { accessKey: "fake-access", secretKey: "fake-secret", sessionToken: "fake-session" }, "us-east-1", "ce", NOW, "AWSInsightsIndexService.GetCostAndUsage");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const stamp = headers["x-amz-date"];
  const day = stamp.slice(0, 8);
  const names = "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token;x-amz-target";
  const canonical = `POST\n/\n\ncontent-type:application/x-amz-json-1.1\nhost:ce.us-east-1.amazonaws.com\nx-amz-content-sha256:${sha(body)}\nx-amz-date:${stamp}\nx-amz-security-token:fake-session\nx-amz-target:AWSInsightsIndexService.GetCostAndUsage\n\n${names}\n${sha(body)}`;
  const dateKey = createHmac("sha256", "AWS4fake-secret").update(day).digest();
  const regionKey = createHmac("sha256", dateKey).update("us-east-1").digest();
  const serviceKey = createHmac("sha256", regionKey).update("ce").digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  const signature = createHmac("sha256", signingKey).update(`AWS4-HMAC-SHA256\n${stamp}\n${day}/us-east-1/ce/aws4_request\n${sha(canonical)}`).digest("hex");
  assert.equal(headers.authorization, `AWS4-HMAC-SHA256 Credential=fake-access/${day}/us-east-1/ce/aws4_request, SignedHeaders=${names}, Signature=${signature}`);
});

test("Bedrock keeps spend through a timed-out optional CloudWatch request", async () => {
  const context = fakeContext({ env, responses: [json(spend)] });
  const original = context.fetch;
  context.fetch = async (input, init) => {
    if (String(input).includes("monitoring")) throw new DOMException("timed out", "TimeoutError");
    return original(input, init);
  };
  assert.equal((await bedrock.fetch(context))[0].windows[0].value, "$12.50");
});

test("Bedrock respects explicit profile mode, AWS_CLI_PATH, timeouts, and region precedence", async () => {
  const context = fakeContext({ env: { ...env, AWS_PROFILE: "work", CODEXBAR_BEDROCK_AUTH_MODE: "profile", AWS_CLI_PATH: "/custom/aws", AWS_REGION: "eu-west-1" },
    commands: { "/custom/aws configure export-credentials --profile work --format process": { code: 0, stdout: JSON.stringify({ AccessKeyId: "fake-profile", SecretAccessKey: "fake-secret" }), stderr: "" } },
    responses: [json(spend), json(activity)] });
  const original = context.run;
  context.run = async (command, args, options) => {
    assert.equal(options?.timeoutMs, 20000);
    assert.equal(options?.env?.AWS_CLI_AUTO_PROMPT, "off");
    assert.equal(options?.env?.AWS_PROFILE, "");
    return original(command, args, options);
  };
  await bedrock.fetch(context);
  assert.deepEqual(context.runs, ["/custom/aws configure export-credentials --profile work --format process"]);
  assert.match(context.calls[0].headers.authorization, /fake-profile/);
  assert.equal(context.calls[1].url, "https://monitoring.eu-west-1.amazonaws.com/");
});
