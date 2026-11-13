import assert from "node:assert/strict";
import { test } from "node:test";
import { coderabbit } from "../src/providers/coderabbit.ts";
import { HttpError, NotConfigured } from "../src/providers/types.ts";
import { fakeContext } from "./helpers.ts";

test("CodeRabbit: parses CLI billing summary without inventing a quota", async () => {
  const context = fakeContext({ commands: { "coderabbit usage": { code: 0,
    stdout: "Organization: Test\nUser: tester\nPlan: Pro\nYour reviews: 42\nUsage billing: Enabled\nPeriod resets: Dec 1", stderr: "" } } });
  const [account] = await coderabbit.fetch(context);
  assert.equal(account.account, "default");
  assert.equal(account.windows[0].value, "42");
  assert.equal(account.windows[0].used_percent, null);
});
test("CodeRabbit: missing CLI", async () => {
  await assert.rejects(coderabbit.fetch(fakeContext({})), NotConfigured);
});
test("CodeRabbit: signed out", async () => {
  const [account] = await coderabbit.fetch(fakeContext({ commands: { "coderabbit usage": { code: 1, stdout: "", stderr: "Authentication required. Run auth login" } } }));
  assert.equal(account.error, "sign in");
});
for (const code of [0, 1, null]) test(`CodeRabbit: invalid output, exit ${code}`, async () => {
  await assert.rejects(coderabbit.fetch(fakeContext({ commands: { "coderabbit usage": { code, stdout: "unexpected", stderr: "" } } })), HttpError);
});
test("CodeRabbit: honors CLI path and ANSI output", async () => {
  const context = fakeContext({ env: { CODERABBIT_CLI_PATH: "/test/coderabbit" }, commands: { "/test/coderabbit usage": { code: 0, stdout: "\x1b[32mYour reviews: 0\x1b[0m", stderr: "" } } });
  assert.equal((await coderabbit.fetch(context))[0].windows[0].value, "0");
});
test("CodeRabbit: billing-only output has no invented counters", async () => {
  const context = fakeContext({ commands: { "coderabbit usage": { code: 0, stdout: "Usage billing: Disabled", stderr: "" } } });
  assert.deepEqual((await coderabbit.fetch(context))[0].windows, []);
});
