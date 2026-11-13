import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { pi } from "../src/providers/pi.ts";
import { HttpError, NotConfigured } from "../src/providers/types.ts";
import { fakeContext, NOW } from "./helpers.ts";

const root = "/home/test/.pi/agent/sessions";
function transcript(usage: unknown = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }) {
  return (
    [
      { type: "session", version: 3, id: "fake-session" },
      {
        type: "message",
        id: "turn1",
        timestamp: new Date((NOW - 60) * 1000).toISOString(),
        message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-5", usage },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n"
  );
}
test("Pi: local transcript token totals, no invented quota", async () => {
  const [account] = await pi.fetch(
    fakeContext({
      dirs: { [root]: ["project"], [`${root}/project`]: ["session.jsonl"] },
      files: { [`${root}/project/session.jsonl`]: transcript() },
    }),
  );
  assert.deepEqual(
    account.windows.map((w) => w.value),
    ["1.2k tok", "1.2k tok"],
  );
  assert.equal(account.blocked, false);
});
test("Pi: missing history", async () => {
  await assert.rejects(pi.fetch(fakeContext({})), NotConfigured);
});
test("Pi: malformed usage does not become zero", async () => {
  await assert.rejects(
    pi.fetch(
      fakeContext({
        dirs: { [root]: ["session.jsonl"] },
        files: { [`${root}/session.jsonl`]: transcript({ input: -1 }) },
      }),
    ),
    HttpError,
  );
});
test("Pi: honors explicit session root and deduplicates roots", async () => {
  const context = fakeContext({
    env: { PI_CODING_AGENT_DIR: "/agent", PI_CODING_AGENT_SESSION_DIR: "/agent/sessions" },
    dirs: { "/agent/sessions": ["session.jsonl"] },
    files: { "/agent/sessions/session.jsonl": transcript() },
  });
  assert.equal((await pi.fetch(context))[0].windows[0].value, "1.2k tok");
});
test("Pi: invalid explicit selector fails closed", async () => {
  await assert.rejects(pi.fetch(fakeContext({ env: { PI_CODING_AGENT_SESSION_DIR: "relative" } })), HttpError);
});
test("Pi: invalid first-present one-hour counter does not fall through", async () => {
  await assert.rejects(
    pi.fetch(
      fakeContext({
        dirs: { [root]: ["session.jsonl"] },
        files: {
          [`${root}/session.jsonl`]: transcript({ input: 1, cacheWrite: 5, cacheWrite1h: "bad", cache_write_1h: 0 }),
        },
      }),
    ),
    HttpError,
  );
});
