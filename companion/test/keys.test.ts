import assert from "node:assert/strict";
import { test } from "node:test";
import { apiKey } from "../src/keys.ts";
import { fakeContext } from "./helpers.ts";

test("an environment variable wins, in the order given", async () => {
  const context = fakeContext({ env: { B_KEY: "from-b", A_KEY: " " } });
  assert.equal(await apiKey(context, "demo", ["A_KEY", "B_KEY"]), "from-b");
});

test("the companion's config comes next", async () => {
  const context = fakeContext({
    files: {
      "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { demo: { apiKey: "from-companion" } } }),
      "/home/test/.config/codexbar/config.json": JSON.stringify({ providers: [{ id: "demo", apiKey: "from-codexbar" }] }),
    },
  });
  assert.equal(await apiKey(context, "demo", ["DEMO_KEY"]), "from-companion");
});

test("reads CodexBar's config, including its selected token account", async () => {
  const direct = fakeContext({
    files: { "/home/test/.codexbar/config.json": JSON.stringify({ providers: [{ id: "demo", apiKey: "legacy-path" }] }) },
  });
  assert.equal(await apiKey(direct, "demo", []), "legacy-path");

  const accounts = fakeContext({
    env: { XDG_CONFIG_HOME: "/xdg" },
    files: {
      "/xdg/codexbar/config.json": JSON.stringify({
        providers: [{ id: "demo", apiKey: null, tokenAccounts: { activeIndex: 1, accounts: [{ token: "first" }, { token: "second" }] } }],
      }),
    },
  });
  assert.equal(await apiKey(accounts, "demo", []), "second");
});

test("no key anywhere is null, and a broken config file is ignored", async () => {
  const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": "{not json" } });
  assert.equal(await apiKey(context, "demo", ["DEMO_KEY"]), null);
});
