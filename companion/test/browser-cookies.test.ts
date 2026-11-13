import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { test } from "vite-plus/test";
import { browserCookieHeader } from "../src/browser-cookies.ts";
import { fakeContext, NOW } from "./helpers.ts";
const sql = "SELECT host_key, name, value, encrypted_value, expires_utc, path FROM cookies";
const meta = "SELECT value FROM meta WHERE key = 'version'";
const ff = "SELECT host, name, value, expiry, path FROM moz_cookies";
const root = "/home/test/Library/Application Support/Google/Chrome";
const db = `${root}/Default/Cookies`;
const row = (name: string, value: string, host = ".example.com", expiry = 0) => ({
  name,
  value,
  host_key: host,
  expires_utc: expiry,
  path: "/",
});
function encrypted(prefix: boolean, linux: boolean) {
  const cipher = createCipheriv(
    "aes-128-cbc",
    pbkdf2Sync(linux ? "peanuts" : "password", "saltysalt", linux ? 1 : 1003, 16, "sha1"),
    Buffer.alloc(16, 32),
  );
  return Buffer.concat([
    Buffer.from("v10"),
    cipher.update(
      Buffer.concat([
        prefix ? createHash("sha256").update(".example.com").digest() : Buffer.alloc(0),
        Buffer.from("token"),
      ]),
    ),
    cipher.final(),
  ]);
}
for (const prefix of [false, true])
  for (const linux of [false, true]) {
    test(`v10 prefix=${prefix} linux=${linux}`, async () => {
      const base = linux ? "/home/test/.config/google-chrome" : root;
      const context = fakeContext({
        platform: linux ? "linux" : "darwin",
        dirs: { [base]: ["Default"] },
        keychain: { "Chrome Safe Storage/Chrome": "password" },
        sqlite: {
          [`${base}/Default/Cookies::${sql}`]: [
            { ...row("session", ""), encrypted_value: encrypted(prefix, linux) },
            { ...row("skip", ""), encrypted_value: Buffer.from("v11unsupported") },
          ],
          [`${base}/Default/Cookies::${meta}`]: [{ value: prefix ? "24" : "23" }],
        },
      });
      assert.equal(await browserCookieHeader(context, ["www.example.com"], ["session"]), "session=token");
    });
  }
test("domain boundary, expiry, required names, browser and profile order", async () => {
  const brave = "/home/test/Library/Application Support/BraveSoftware/Brave-Browser";
  const context = fakeContext({
    platform: "darwin",
    dirs: { [root]: ["Profile 2", "Default"], [brave]: ["Default"] },
    sqlite: {
      [`${db}::${sql}`]: [row("a", "first")],
      [`${root}/Profile 2/Cookies::${sql}`]: [
        row("a", "second"),
        row("b", "ok"),
        row("wrong", "no", "badexample.com"),
        row("hostOnly", "no", "example.com"),
        row("expired", "no", ".example.com", (NOW - 1 + 11644473600) * 1e6),
      ],
      [`${brave}/Default/Cookies::${sql}`]: [row("a", "brave"), row("b", "ok")],
    },
  });
  assert.equal(await browserCookieHeader(context, ["www.example.com"], []), "a=first");
  assert.equal(await browserCookieHeader(context, ["www.example.com"], ["a", "b"]), "a=second; b=ok");
  assert.equal(await browserCookieHeader(context, ["www.example.com"], ["missing"]), null);
});
test("Firefox relative and absolute profiles", async () => {
  const base = "/home/test/Library/Application Support/Firefox";
  const context = fakeContext({
    platform: "darwin",
    files: {
      [`${base}/profiles.ini`]:
        "[Profile0]\nPath=Profiles/one\nIsRelative=1\n[Profile1]\nPath=/external/two\nIsRelative=0\n",
    },
    sqlite: {
      [`${base}/Profiles/one/cookies.sqlite::${ff}`]: [
        { host: ".example.com", name: "session", value: "expired", expiry: NOW - 1 },
      ],
      [`/external/two/cookies.sqlite::${ff}`]: [
        { host: "example.com", name: "session", value: "firefox", expiry: NOW + 1 },
      ],
    },
  });
  assert.equal(await browserCookieHeader(context, ["example.com"], ["session"]), "session=firefox");
});
function safariFixture() {
  const strings = [".example.com", "session", "/", "safari"];
  const record = Buffer.alloc(56 + strings.reduce((size, s) => size + s.length + 1, 0));
  record.writeUInt32LE(record.length, 0);
  let offset = 56;
  for (const [index, value] of strings.entries()) {
    record.writeUInt32LE(offset, 16 + index * 4);
    record.write(value, offset);
    offset += value.length + 1;
  }
  record.writeDoubleLE(NOW + 100 - 978307200, 40);
  const page = Buffer.alloc(16);
  page.writeUInt32BE(0x100, 0);
  page.writeUInt32LE(1, 4);
  page.writeUInt32LE(16, 8);
  const file = Buffer.alloc(12);
  file.write("cook");
  file.writeUInt32BE(1, 4);
  file.writeUInt32BE(page.length + record.length, 8);
  return Buffer.concat([file, page, record]);
}
test("Safari binarycookies and truncated files", async () => {
  const path = "/home/test/Library/Cookies/Cookies.binarycookies";
  const fixture = safariFixture();
  assert.equal(
    await browserCookieHeader(
      fakeContext({ platform: "darwin", binaryFiles: { [path]: fixture } }),
      ["www.example.com"],
      ["session"],
    ),
    "session=safari",
  );
  for (const length of [0, 7, 13, fixture.length - 1])
    assert.equal(
      await browserCookieHeader(
        fakeContext({ platform: "darwin", binaryFiles: { [path]: fixture.subarray(0, length) } }),
        ["example.com"],
        [],
      ),
      null,
    );
});
test("locked database and declined Keychain fall back", async () => {
  const context = fakeContext({
    platform: "darwin",
    dirs: { [root]: ["Default", "Profile 1"] },
    sqlite: { [`${root}/Profile 1/Cookies::${sql}`]: [row("session", "fallback")] },
  });
  const query = context.querySqlite;
  context.querySqlite = async (path, statement) => {
    if (path === `${root}/Default/Network/Cookies`) throw new Error("locked");
    if (path === db && statement === sql) return [{ ...row("session", ""), encrypted_value: encrypted(false, false) }];
    return query(path, statement);
  };
  context.readKeychain = async () => {
    throw new Error("declined");
  };
  assert.equal(await browserCookieHeader(context, ["example.com"], []), "session=fallback");
});

test("reads each browser store at most once per ten minutes for the same domains", async () => {
  let now = 1_800_000_000;
  let reads = 0;
  const base = fakeContext({ platform: "darwin" });
  const context = {
    ...base,
    now: () => now,
    async listDir(path: string) {
      reads += 1;
      return base.listDir(path);
    },
  };
  await browserCookieHeader(context, ["example.com"], []);
  const first = reads;
  await browserCookieHeader(context, ["example.com"], []);
  assert.equal(reads, first);
  now += 601;
  await browserCookieHeader(context, ["example.com"], []);
  assert.ok(reads > first);
});
