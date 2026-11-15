import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { accountLabel, feedWindow, windowName } from "../src/feed.ts";

test("names windows by their length", () => {
  assert.equal(windowName(300), "5h");
  assert.equal(windowName(10080), "7d");
  assert.equal(windowName(45), "45m");
});

test("labels accounts by email domain, as the hub does", () => {
  assert.equal(accountLabel("someone@gmail.com"), "gmail");
  assert.equal(accountLabel("a@My-Company.co.uk"), "my_company");
  assert.equal(accountLabel(null), "default");
});

test("a window past its reset counts as unused", () => {
  assert.equal(feedWindow(300, 80, 100, 200).used_percent, 0);
  assert.equal(feedWindow(300, 79.6, 300, 200).used_percent, 80);
});
