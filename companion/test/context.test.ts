import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { cookieHeader } from "../src/cookies.ts";
import { systemContext } from "../src/context.ts";
import { providerEntry } from "../src/keys.ts";
import { fakeContext } from "./helpers.ts";

test("runs a program without a shell, with input, and reports a missing one as null", async () => {
  const context = systemContext();
  const result = await context.run(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { input: "a;b $(x)" });
  assert.deepEqual(result, { code: 0, stdout: "a;b $(x)", stderr: "" });
  assert.equal(await context.run("busybar-usage-no-such-program", []), null);
  const slow = await context.run(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 100 });
  assert.equal(slow?.code, null);
});

test("queries a copy of a SQLite database read-only, and files and directories read as null when missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "busybar-usage-test-"));
  try {
    const path = join(dir, "state.db");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE kv (key TEXT, value TEXT); INSERT INTO kv VALUES ('a', '1');");
    database.close();
    const context = systemContext();
    assert.deepEqual(await context.querySqlite(path, "SELECT value FROM kv WHERE key = ?", ["a"]), [{ value: "1" }]);
    assert.equal(await context.querySqlite(join(dir, "missing.db"), "SELECT 1"), null);
    await writeFile(join(dir, "raw.bin"), new Uint8Array([0, 255]));
    assert.deepEqual(await context.readFileBytes(join(dir, "raw.bin")), new Uint8Array([0, 255]));
    assert.deepEqual((await context.listDir(dir))?.sort(), ["raw.bin", "state.db"]);
    assert.equal(await context.listDir(join(dir, "nope")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a cookie header comes from env, then saved config, and CodexBar's Off disables browser cookies", async () => {
  const domains = { domains: ["example.com"], envNames: ["DEMO_COOKIE"] };
  assert.equal(await cookieHeader(fakeContext({ env: { DEMO_COOKIE: "a=1" } }), "demo", domains), "a=1");
  const saved = fakeContext({
    files: { "/home/test/.codexbar/config.json": JSON.stringify({ providers: [{ id: "demo", cookieHeader: "b=2" }] }) },
  });
  assert.equal(await cookieHeader(saved, "demo", domains), "b=2");
  const off = fakeContext({
    files: { "/home/test/.codexbar/config.json": JSON.stringify({ providers: [{ id: "demo", cookieSource: "off" }] }) },
  });
  assert.equal(await cookieHeader(off, "demo", domains), null);
});

test("provider settings prefer the companion's entry over CodexBar's", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { demo: { region: "eu" } } }),
      "/home/test/.codexbar/config.json": JSON.stringify({ providers: [{ id: "demo", region: "us" }] }),
    },
  });
  assert.deepEqual(await providerEntry(context, "demo"), { region: "eu" });
  assert.deepEqual(await providerEntry(fakeContext({}), "demo"), {});
});
