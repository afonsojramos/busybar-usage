import assert from "node:assert/strict";
import { test } from "node:test";
import { browserLocalStorage } from "../src/browser-local-storage.ts";
import { factory } from "../src/providers/factory.ts";
import { devin } from "../src/providers/devin.ts";
import { windsurf } from "../src/providers/windsurf.ts";
import { fakeContext, json, NOW } from "./helpers.ts";

const root = "/home/test/.config/google-chrome";
const store = `${root}/Default/Local Storage/leveldb`;
function vint(n: number): Buffer {
  const bytes: number[] = [];
  do { const byte = n % 128; n = Math.floor(n / 128); bytes.push(byte | (n ? 128 : 0)); } while (n);
  return Buffer.from(bytes);
}
function fixed(n: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function field(b: Buffer): Buffer { return Buffer.concat([vint(b.length), b]); }
function encoded(s: string, utf16 = false): Buffer { return Buffer.concat([Buffer.from([utf16 ? 0 : 1]), Buffer.from(s, utf16 ? "utf16le" : "latin1")]); }
function key(origin: string, name: string, utf16 = false): Buffer { return Buffer.concat([Buffer.from(`_${origin}\0`), encoded(name, utf16)]); }
type RecordValue = { key: Buffer; value: Buffer | null };
function batch(sequence: number, records: RecordValue[]): Buffer {
  const header = Buffer.alloc(12); header.writeBigUInt64LE(BigInt(sequence)); header.writeUInt32LE(records.length, 8);
  return Buffer.concat([header, ...records.map(({ key, value }) => Buffer.concat([Buffer.from([value === null ? 0 : 1]), field(key), ...(value === null ? [] : [field(value)])]))]);
}
function checksum(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}
function physical(bytes: Buffer, type = 1): Buffer {
  const header = Buffer.alloc(7); header.writeUInt16LE(bytes.length, 4); header[6] = type;
  header.writeUInt32LE(checksum(Buffer.concat([Buffer.from([type]), bytes])));
  return Buffer.concat([header, bytes]);
}
function wal(sequence: number, records: RecordValue[]): Buffer { return physical(batch(sequence, records)); }
function block(records: [Buffer, Buffer][]): Buffer {
  let previous: Buffer = Buffer.alloc(0);
  return Buffer.concat([...records.map(([key, value]) => {
    let shared = 0;
    while (shared < previous.length && shared < key.length && previous[shared] === key[shared]) shared++;
    previous = key;
    return Buffer.concat([vint(shared), vint(key.length - shared), vint(value.length), key.subarray(shared), value]);
  }), fixed(0), fixed(1)]);
}
function compressed(bytes: Buffer, copyKind = 2): Buffer {
  const literalBytes = bytes.subarray(0, -4);
  const length = literalBytes.length;
  let literal: Buffer;
  if (length <= 60) literal = Buffer.from([(length - 1) << 2]);
  else {
    const sizeBytes: number[] = [];
    let size = length - 1;
    do { sizeBytes.push(size % 256); size = Math.floor(size / 256); } while (size);
    literal = Buffer.from([(59 + sizeBytes.length) << 2, ...sizeBytes]);
  }
  // Duplicate the zero restart offset with COPY_2, then emit restart count two.
  const copy = copyKind === 1 ? [1, 1] : copyKind === 2 ? [14, 1, 0] : [15, 1, 0, 0, 0];
  return Buffer.concat([vint(bytes.length + 4), literal, literalBytes, Buffer.from([...copy, 12]), fixed(2)]);
}
function table(records: (RecordValue & { sequence: number })[], snappy = false, copyKind = 2): Buffer {
  const data = block(records.map(({ key, value, sequence }) => {
    const suffix = Buffer.alloc(8); suffix.writeBigUInt64LE(BigInt(sequence) * 256n + (value === null ? 0n : 1n));
    return [Buffer.concat([key, suffix]), value ?? Buffer.alloc(0)];
  }));
  const raw = snappy ? compressed(data, copyKind) : data;
  const body = Buffer.concat([raw, Buffer.from([snappy ? 1 : 0])]);
  const dataBlock = Buffer.concat([body, fixed(checksum(body))]);
  const index = block([[Buffer.from("z"), Buffer.concat([vint(0), vint(raw.length)])]]);
  const footer = Buffer.alloc(48);
  Buffer.concat([vint(0), vint(0), vint(dataBlock.length), vint(index.length)]).copy(footer);
  footer.writeBigUInt64LE(0xdb4775248b80fb57n, 40);
  const indexBody = Buffer.concat([index, Buffer.from([0])]);
  return Buffer.concat([dataBlock, indexBody, fixed(checksum(indexBody)), footer]);
}
function contextFor(origin: string, values: Record<string, string>, responses: Response[] = []) {
  return fakeContext({ dirs: { [root]: ["Default"], [store]: ["000001.log"] }, binaryFiles: {
    [`${store}/000001.log`]: wal(10, Object.entries(values).map(([name, value]) => ({ key: key(origin, name), value: encoded(value) }))),
  }, responses });
}

test("resolves sequences, deletes and both Chromium string encodings across WAL and tables", async () => {
  const origin = "https://app.factory.ai";
  const context = fakeContext({ dirs: { [root]: ["Default"], [store]: ["000009.ldb", "000001.log", "000008.sst"] }, binaryFiles: {
    [`${store}/000009.ldb`]: table([
      { key: key(origin, "overwrite"), value: encoded("old"), sequence: 2 },
      { key: key(origin, "delete"), value: encoded("gone"), sequence: 3 },
      { key: key(origin, "unicode", true), value: encoded("こんにちは😀", true), sequence: 4 },
      { key: Buffer.from("META:https://app.factory.ai"), value: Buffer.from("ignored"), sequence: 5 },
    ]),
    [`${store}/000008.sst`]: table([{ key: key(origin, "latin"), value: encoded("café"), sequence: 8 }]),
    [`${store}/000001.log`]: wal(20, [
      { key: key(origin, "overwrite"), value: encoded("new") },
      { key: key(origin, "delete"), value: null },
      { key: key("https://other.example", "other"), value: encoded("hidden") },
      { key: Buffer.from("VERSION"), value: Buffer.from("1" ) },
    ]),
  } });
  const result = await browserLocalStorage(context, origin, () => true);
  assert.deepEqual(result, new Map([["overwrite", "new"], ["unicode", "こんにちは😀"], ["latin", "café"]]));
  assert.equal(await browserLocalStorage(context, origin, "delete"), null);
});

for (const copyKind of [1, 2, 3]) test(`reads Snappy compressed table blocks with copy kind ${copyKind}`, async () => {
  const origin = "https://app.factory.ai";
  const raw = table([{ key: key(origin, "token"), value: encoded("session".repeat(100)), sequence: 1 }], true, copyKind);
  const context = fakeContext({ dirs: { [root]: ["Default"], [store]: ["000001.ldb"] }, binaryFiles: { [`${store}/000001.ldb`]: raw } });
  assert.equal(await browserLocalStorage(context, origin, "token"), "session".repeat(100));
});

test("reassembles WAL records across physical blocks and ignores incomplete tails", async () => {
  const origin = "https://app.factory.ai";
  const payload = batch(1, [{ key: key(origin, "large"), value: encoded("a".repeat(40000)) }]);
  const bytes = Buffer.concat([physical(payload.subarray(0, 32761), 2), physical(payload.subarray(32761), 4), Buffer.from([1, 2, 3])]);
  const context = fakeContext({ dirs: { [root]: ["Default"], [store]: ["000001.log"] }, binaryFiles: { [`${store}/000001.log`]: bytes } });
  assert.equal((await browserLocalStorage(context, origin, "large"))?.length, 40000);
});

test("caches per context for ten minutes and returns defensive predicate maps", async () => {
  const origin = "https://app.factory.ai", context = contextFor(origin, { token: "first" });
  let now = NOW, reads = 0;
  context.now = () => now;
  const read = context.readFileBytes;
  context.readFileBytes = async (path) => { reads++; return read(path); };
  const result = await browserLocalStorage(context, origin, () => true); result?.clear();
  assert.equal(await browserLocalStorage(context, origin, "token"), "first");
  assert.equal(reads, 1);
  now += 600;
  await browserLocalStorage(context, origin, "token");
  assert.equal(reads, 2);
});

test("skips unreadable stores, preserves browser/profile order and never mixes profiles", async () => {
  const origin = "https://windsurf.com";
  const context = fakeContext({ dirs: { [root]: ["Profile 2", "Default", "Profile 1"],
    [`${root}/Default/Local Storage/leveldb`]: ["000001.log"],
    [`${root}/Profile 1/Local Storage/leveldb`]: ["000001.log"],
    [`${root}/Profile 2/Local Storage/leveldb`]: ["000001.log"],
  }, binaryFiles: {
    [`${root}/Profile 1/Local Storage/leveldb/000001.log`]: wal(1, [{ key: key(origin, "a"), value: encoded("one") }]),
    [`${root}/Profile 2/Local Storage/leveldb/000001.log`]: wal(1, [{ key: key(origin, "b"), value: encoded("two") }]),
  } });
  const read = context.readFileBytes;
  context.readFileBytes = async (path) => { if (path.includes("/Default/")) throw new Error("unreadable"); return read(path); };
  assert.equal(await browserLocalStorage(context, origin, "a"), "one");
  assert.equal(await browserLocalStorage(context, origin, () => true, (values) => values.has("a") && values.has("b")), null);
  assert.equal(await browserLocalStorage(fakeContext({}), origin, "missing"), null);
});

test("Factory uses Chromium WorkOS access token without refreshing", async () => {
  const context = contextFor("https://app.factory.ai", { "workos:access-token": "factory-session", "workos:refresh-token": "must-not-use" }, [
    json({ userProfile: { email: "test@example.com", id: "test" } }),
    json({ usesTokenRateLimitsBilling: true, limits: { standard: { fiveHour: { usedPercent: 12 }, weekly: { usedPercent: 34 } } } }),
  ]);
  assert.equal((await factory.fetch(context))[0]?.windows[0]?.used_percent, 12);
  assert.ok(context.calls.every((call) => call.headers.authorization === "Bearer factory-session"));
});

test("Devin uses Chromium auth1 session and organization", async () => {
  const context = contextFor("https://app.devin.ai", {
    auth1_session: JSON.stringify({ token: "auth1_test_session_long_enough" }),
    "last-internal-org-for-external-org-v1-test": JSON.stringify("org_12345678"),
  }, [json({ daily_percentage: 12, weekly_percentage: 34 })]);
  assert.equal((await devin.fetch(context))[0]?.windows[0]?.used_percent, 12);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer auth1_test_session_long_enough");
  assert.equal(context.calls[0]?.headers["x-cog-org-id"], "org_12345678");
});

for (const origin of ["https://app.devin.ai", "https://windsurf.com"]) test(`Windsurf uses complete Chromium session at ${origin}`, async () => {
  const context = contextFor(origin, {
    devin_session_token: JSON.stringify("windsurf-session"), devin_auth1_token: "auth1-session",
    devin_account_id: "account", devin_primary_org_id: "org",
  }, [new Response(Buffer.from([10, 2, 112, 90]))]);
  // field 14 (remaining daily percent) in the nested plan message.
  assert.equal((await windsurf.fetch(context))[0]?.windows[0]?.used_percent, 10);
  assert.equal(context.calls[0]?.headers["x-devin-session-token"], "windsurf-session");
});

test("manifest excludes obsolete tables and logs so signed-out sessions cannot reappear", async () => {
  const origin = "https://app.factory.ai";
  const edit = Buffer.concat([vint(2), vint(5), vint(7), vint(0), vint(2), vint(100), field(Buffer.from("a")), field(Buffer.from("z"))]);
  const context = fakeContext({ dirs: { [root]: ["Default"], [store]: ["CURRENT", "MANIFEST-000004", "000001.ldb", "000002.ldb", "000003.log"] }, binaryFiles: {
    [`${store}/CURRENT`]: Buffer.from("MANIFEST-000004\n"), [`${store}/MANIFEST-000004`]: physical(edit),
    [`${store}/000001.ldb`]: table([{ key: key(origin, "removed"), value: encoded("obsolete"), sequence: 1 }]),
    [`${store}/000002.ldb`]: table([{ key: key(origin, "current"), value: encoded("current"), sequence: 5 }]),
    [`${store}/000003.log`]: wal(10, [{ key: key(origin, "removed"), value: encoded("obsolete log") }]),
  } });
  assert.deepEqual(await browserLocalStorage(context, origin, () => true), new Map([["current", "current"]]));
});

test("corrupt and truncated input never throws or exposes session values", async () => {
  const origin = "https://app.factory.ai";
  for (const bytes of [Buffer.alloc(0), Buffer.from("malformed"), table([{ key: key(origin, "token"), value: encoded("session"), sequence: 1 }]).subarray(0, 20)]) {
    const context = fakeContext({ dirs: { [root]: ["Default"], [store]: ["000001.ldb"] }, binaryFiles: { [`${store}/000001.ldb`]: bytes } });
    assert.equal(await browserLocalStorage(context, origin, "token"), null);
  }
  const context = contextFor(origin, { token: "secret" });
  const read = context.readFileBytes;
  context.readFileBytes = async (path) => { const bytes = await read(path); if (!bytes) return null; const bad = Buffer.from(bytes); bad[0] ^= 1; return bad; };
  assert.equal(await browserLocalStorage(context, origin, "token"), null);
});

test("macOS and Linux XDG roots use the shared browser order and root profiles", async () => {
  const origin = "https://app.factory.ai";
  for (const platform of ["darwin", "linux"] as const) {
    const base = platform === "darwin" ? "/home/test/Library/Application Support/BraveSoftware/Brave-Browser" : "/custom/BraveSoftware/Brave-Browser";
    const path = `${base}/Local Storage/leveldb`;
    const context = fakeContext({ platform, env: { XDG_CONFIG_HOME: "/custom" }, dirs: { [base]: [], [path]: ["000001.log"] }, binaryFiles: {
      [`${path}/000001.log`]: wal(1, [{ key: key(origin, "token"), value: encoded("brave") }]),
    } });
    assert.equal(await browserLocalStorage(context, origin, "token"), "brave");
  }
});

test("Devin browser credentials precede desktop secrets", async () => {
  const context = contextFor("https://app.devin.ai", { auth1_session: JSON.stringify({ token: "auth1_browser_session_long_enough" }), "last-internal-org-for-external-org-v1-team": "org_12345678" }, [json({ daily_percentage: 12 })]);
  let desktopRead = false;
  context.querySqlite = async () => { desktopRead = true; return null; };
  await devin.fetch(context);
  assert.equal(desktopRead, false);
});

test("manual/off and CLI source controls do not scan browser storage", async () => {
  for (const provider of [factory, devin, windsurf]) {
    for (const entry of [{ cookieSource: "off" }, { cookieSource: "manual" }, ...(provider.id === "windsurf" ? [{ usageDataSource: "cli" }] : [])]) {
      const context = fakeContext({ files: { "/home/test/.config/busybar-usage/config.json": JSON.stringify({ providers: { [provider.id]: entry } }) } });
      let scanned = false;
      context.listDir = async () => { scanned = true; return null; };
      await assert.rejects(provider.fetch(context));
      assert.equal(scanned, false);
    }
  }
});

test("Devin discovers nested Auth0 tokens and organization metadata", async () => {
  const context = contextFor("https://app.devin.ai", {
    "auth0spajs@@::test": JSON.stringify({ body: { access_token: "eyJ.test_auth0_session_long_enough" } }),
    organization: JSON.stringify({ internalOrgId: "org_12345678", orgName: "team" }),
  }, [json({ daily_percentage: 12 })]);
  assert.equal((await devin.fetch(context))[0]?.windows[0]?.used_percent, 12);
  assert.equal(context.calls[0]?.headers.authorization, "Bearer eyJ.test_auth0_session_long_enough");
});
