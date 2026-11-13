import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { APP_ID, pushFeed } from "../src/bar.ts";
import { Collector } from "../src/collector.ts";
import type { FeedAccount } from "../src/feed.ts";
import { NotConfigured, RateLimited, type Provider } from "../src/providers/types.ts";
import { fakeContext, NOW } from "./helpers.ts";

const account = (percent: number): FeedAccount => ({
  provider: "test",
  account: "default",
  blocked: false,
  observed_at: "2026-11-13T00:00:00Z",
  windows: [{ name: "5h", minutes: 300, used_percent: percent, resets_at: null }],
});

function scripted(results: Array<FeedAccount[] | Error>): Provider & { calls: number } {
  const provider = {
    id: "test",
    name: "Test",
    calls: 0,
    async fetch() {
      const result = results[provider.calls++];
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return provider;
}

test("keeps the last numbers through a failure, backs off, and logs each change once", async () => {
  const logs: string[] = [];
  let now = NOW;
  const context = { ...fakeContext({}), now: () => now };
  const provider = scripted([[account(10)], new Error("boom"), [account(20)]]);
  const collector = new Collector([provider], context, (message) => logs.push(message));

  assert.equal((await collector.collect()).accounts[0].windows[0].used_percent, 10);
  now += 60;
  assert.equal((await collector.collect()).accounts[0].windows[0].used_percent, 10);
  now += 60;
  await collector.collect();
  assert.equal(provider.calls, 2, "waits out the backoff");
  now += 300;
  assert.equal((await collector.collect()).accounts[0].windows[0].used_percent, 20);
  assert.deepEqual(logs, ["Test: updated", "Test: request failed (Error); keeping the last numbers", "Test: updated"]);
});

test("waits for a rate limit to pass", async () => {
  let now = NOW;
  const context = { ...fakeContext({}), now: () => now };
  const provider = scripted([new RateLimited("Test", NOW + 120), [account(5)]]);
  const collector = new Collector([provider], context, () => {});
  await collector.collect();
  now += 60;
  await collector.collect();
  assert.equal(provider.calls, 1);
  now += 60;
  assert.equal((await collector.collect()).accounts.length, 1);
});

test("drops the last numbers after an hour, even during a long rate limit", async () => {
  let now = NOW;
  const context = { ...fakeContext({}), now: () => now };
  const provider = scripted([[account(5)], new RateLimited("Test", NOW + 86400)]);
  const collector = new Collector([provider], context, () => {});
  await collector.collect();
  now += 60;
  assert.equal((await collector.collect()).accounts.length, 1);
  now += 3600;
  assert.deepEqual((await collector.collect()).accounts, []);
});

test("asks a provider with a minimum interval at most that often", async () => {
  let now = NOW;
  const context = { ...fakeContext({}), now: () => now };
  const provider = { ...scripted([[account(1)], [account(2)]]), minIntervalSeconds: 900 };
  const collector = new Collector([provider], context, () => {});
  await collector.collect();
  now += 600;
  assert.equal((await collector.collect()).accounts[0].windows[0].used_percent, 1);
  now += 301;
  assert.equal((await collector.collect()).accounts[0].windows[0].used_percent, 2);
});

test("a hanging provider does not hold up the others, and is not started twice", async () => {
  let starts = 0;
  const hanging: Provider = { id: "slow", name: "Slow", fetch: () => { starts += 1; return new Promise(() => {}); } };
  const collector = new Collector([hanging, scripted([[account(7)], [account(8)]])], fakeContext({}), () => {}, { waitMs: 20 });
  const feed = await collector.collect();
  assert.equal(feed.accounts.length, 1);
  await collector.collect();
  assert.equal(starts, 1);
});

test("a slow provider's numbers arrive with a later collection", async () => {
  let release: (accounts: FeedAccount[]) => void = () => {};
  const slow: Provider = { id: "test", name: "Test", fetch: () => new Promise((resolve) => { release = resolve; }) };
  const collector = new Collector([slow], fakeContext({}), () => {}, { waitMs: 20 });
  assert.equal((await collector.collect()).accounts.length, 0);
  release([account(3)]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await collector.collect()).accounts[0].windows[0].used_percent, 3);
});

test("a failed attempt still counts toward the minimum interval", async () => {
  let now = NOW;
  const context = { ...fakeContext({}), now: () => now };
  const provider = scripted([new Error("boom"), [account(2)]]);
  provider.minIntervalSeconds = 900;
  const collector = new Collector([provider], context, () => {});
  await collector.collect();
  now += 301;
  await collector.collect();
  assert.equal(provider.calls, 1, "the 5-minute error backoff must not beat the 15-minute minimum");
  now += 600;
  await collector.collect();
  assert.equal(provider.calls, 2);
});

test("an attempt still running after 10 minutes is ignored, and the minimum interval still holds", async () => {
  let now = NOW;
  const context = { ...fakeContext({}), now: () => now };
  let release: (accounts: FeedAccount[]) => void = () => {};
  let starts = 0;
  const slow: Provider = {
    id: "test",
    name: "Test",
    minIntervalSeconds: 3600,
    fetch: () => {
      starts += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  };
  const logs: string[] = [];
  const collector = new Collector([slow], context, (message) => logs.push(message), { waitMs: 20 });
  await collector.collect();
  now += 700;
  await collector.collect();
  release([account(42)]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual((await collector.collect()).accounts, []);
  assert.equal(starts, 1, "the minimum interval holds off a new attempt");
  assert.deepEqual(logs, ["Test: still running after 10 minutes; ignoring it"]);
});

test("with no wait limit, a collection waits for every provider", async () => {
  const slow: Provider = { id: "test", name: "Test", fetch: () => new Promise((resolve) => setTimeout(() => resolve([account(4)]), 30)) };
  const collector = new Collector([slow], fakeContext({}), () => {}, { waitMs: Infinity });
  assert.equal((await collector.collect()).accounts[0]?.windows[0].used_percent, 4);
});

test("leaves out providers that are not set up", async () => {
  const collector = new Collector([scripted([new NotConfigured("Test")])], fakeContext({}), () => {});
  assert.deepEqual((await collector.collect()).accounts, []);
});

test("writes where the app reads", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../src/appmeta/manifest.json", import.meta.url), "utf8"));
  assert.equal(APP_ID, manifest.id);
});

test("a failed push does not quote the bar's password", async () => {
  // busy-lib sends the password only after the bar answers /api/version.
  const server = createServer((_request, response) => response.end(JSON.stringify({ api_semver: "27.15.0" })));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      pushFeed({ generated_at: "2026-11-13T00:00:00Z", accounts: [] }, { host: `127.0.0.1:${port}`, password: "secret\u0000value" }),
      (error: Error) => !error.message.includes("secret"),
    );
  } finally {
    server.close();
  }
});
