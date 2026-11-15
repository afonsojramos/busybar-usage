import { browsers } from "./browser-cookies.ts";
import type { Context } from "./providers/types.ts";

type Version = { sequence: bigint; value: Buffer | null };
type Snapshot = { at: number; entries: Map<string, string> };
const caches = new WeakMap<Context, Map<string, Snapshot>>();
const LIMIT = 64 * 1024 * 1024;

function invalid(): never {
  throw new Error("Invalid browser storage");
}

class Reader {
  offset = 0;
  readonly data: Buffer;
  constructor(data: Buffer) {
    this.data = data;
  }
  byte(): number {
    if (this.offset >= this.data.length) invalid();
    return this.data[this.offset++];
  }
  varint(): number {
    let value = 0;
    for (let shift = 0; shift <= 49; shift += 7) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** shift;
      if (!Number.isSafeInteger(value)) invalid();
      if (byte < 128) return value;
    }
    return invalid();
  }
  take(length: number): Buffer {
    if (length < 0 || length > this.data.length - this.offset) invalid();
    const bytes = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
  field(): Buffer {
    return this.take(this.varint());
  }
}

function checksum(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

function snappy(data: Buffer): Buffer {
  const reader = new Reader(data);
  const size = reader.varint();
  if (size > LIMIT) invalid();
  const out = Buffer.alloc(size);
  let written = 0;
  while (reader.offset < data.length) {
    const tag = reader.byte(),
      kind = tag & 3;
    let length: number;
    if (kind === 0) {
      length = tag >>> 2;
      if (length >= 60) {
        const count = length - 59;
        length = 0;
        for (let i = 0; i < count; i++) length += reader.byte() * 2 ** (8 * i);
      }
      length++;
      if (length > size - written) invalid();
      reader.take(length).copy(out, written);
    } else {
      let distance: number;
      if (kind === 1) {
        length = 4 + ((tag >>> 2) & 7);
        distance = ((tag & 224) << 3) + reader.byte();
      } else {
        length = 1 + (tag >>> 2);
        distance = reader.byte() + reader.byte() * 256;
        if (kind === 3) distance += reader.byte() * 65536 + reader.byte() * 16777216;
      }
      if (!distance || distance > written || length > size - written) invalid();
      for (let i = 0; i < length; i++) out[written + i] = out[written + i - distance];
    }
    written += length;
  }
  if (written !== size) invalid();
  return out;
}

function entries(block: Buffer): [Buffer, Buffer][] {
  if (block.length < 4) invalid();
  const restarts = block.readUInt32LE(block.length - 4);
  if (!restarts || restarts > (block.length - 4) / 4) invalid();
  const end = block.length - 4 - restarts * 4;
  const reader = new Reader(block.subarray(0, end));
  const result: [Buffer, Buffer][] = [];
  let previous = Buffer.alloc(0);
  while (reader.offset < end) {
    const shared = reader.varint(),
      added = reader.varint(),
      length = reader.varint();
    if (shared > previous.length) invalid();
    const key = Buffer.concat([previous.subarray(0, shared), reader.take(added)]);
    result.push([key, reader.take(length)]);
    previous = key;
  }
  return result;
}

function table(data: Buffer, put: (key: Buffer, sequence: bigint, value: Buffer | null) => void): void {
  if (data.length < 48 || data.readBigUInt64LE(data.length - 8) !== 0xdb4775248b80fb57n) invalid();
  function block(handle: Reader): Buffer {
    const offset = handle.varint(),
      size = handle.varint();
    if (size > LIMIT || offset > data.length - size - 5) invalid();
    const bytes = data.subarray(offset, offset + size);
    if (checksum(data.subarray(offset, offset + size + 1)) !== data.readUInt32LE(offset + size + 1)) invalid();
    const compression = data[offset + size];
    if (compression === 0) return bytes;
    if (compression === 1) return snappy(bytes);
    return invalid();
  }
  const footer = new Reader(data.subarray(data.length - 48, data.length - 8));
  footer.varint();
  footer.varint(); // Metaindex handle precedes the index handle.
  for (const [, handle] of entries(block(footer))) {
    for (const [key, value] of entries(block(new Reader(handle)))) {
      if (key.length < 8) invalid();
      const tag = key.readBigUInt64LE(key.length - 8),
        type = Number(tag & 255n);
      if (type !== 0 && type !== 1) invalid();
      put(key.subarray(0, -8), tag >> 8n, type === 0 ? null : value);
    }
  }
}

function log(data: Buffer, put: (key: Buffer, sequence: bigint, value: Buffer | null) => void): void {
  records(data, (bytes) => {
    if (bytes.length < 12) invalid();
    const sequence = bytes.readBigUInt64LE(0),
      count = bytes.readUInt32LE(8);
    const reader = new Reader(bytes);
    reader.offset = 12;
    const pending: [Buffer, bigint, Buffer | null][] = [];
    for (let i = 0; i < count; i++) {
      const type = reader.byte();
      if (type !== 0 && type !== 1) invalid();
      const key = reader.field(),
        value = type === 1 ? reader.field() : null;
      pending.push([key, sequence + BigInt(i), value]);
    }
    if (reader.offset !== bytes.length) invalid();
    for (const [key, seq, value] of pending) put(key, seq, value);
  });
}

function records(data: Buffer, consume: (bytes: Buffer) => void): void {
  let fragments: Buffer[] | null = null;
  for (let start = 0; start < data.length; start += 32768) {
    const end = Math.min(start + 32768, data.length);
    for (let offset = start; offset + 7 <= end;) {
      const expected = data.readUInt32LE(offset);
      const length = data.readUInt16LE(offset + 4),
        type = data[offset + 6];
      offset += 7;
      if (type === 0 && length === 0) break;
      if (offset + length > end) {
        fragments = null;
        break;
      }
      const bytes = data.subarray(offset, offset + length);
      offset += length;
      if (checksum(Buffer.concat([Buffer.from([type]), bytes])) !== expected) invalid();
      if (type === 1) {
        fragments = null;
        consume(bytes);
      } else if (type === 2) fragments = [bytes];
      else if (type === 3 && fragments) fragments.push(bytes);
      else if (type === 4 && fragments) {
        fragments.push(bytes);
        consume(Buffer.concat(fragments));
        fragments = null;
      } else fragments = null;
    }
  }
}

function text(bytes: Buffer): string | null {
  if (bytes[0] === 1) return bytes.subarray(1).toString("latin1");
  if (bytes[0] === 0 && bytes.length % 2 === 1) return bytes.subarray(1).toString("utf16le");
  return null;
}

async function optional<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

async function liveFiles(context: Context, path: string, files: string[]): Promise<string[]> {
  if (!files.includes("CURRENT")) return files;
  const current = await context.readFileBytes(`${path}/CURRENT`);
  const name = current ? Buffer.from(current).toString("ascii").trim() : "";
  if (!/^MANIFEST-\d+$/.test(name)) return [];
  const manifest = await context.readFileBytes(`${path}/${name}`);
  if (!manifest || manifest.length > LIMIT) return [];
  const tables = new Set<number>();
  let logNumber = 0,
    previousLog = 0;
  records(Buffer.from(manifest), (bytes) => {
    const reader = new Reader(bytes);
    while (reader.offset < bytes.length) {
      const tag = reader.varint();
      if (tag === 1) reader.field();
      else if (tag === 2) logNumber = reader.varint();
      else if (tag === 9) previousLog = reader.varint();
      else if (tag === 3 || tag === 4) reader.varint();
      else if (tag === 5) {
        reader.varint();
        reader.field();
      } else if (tag === 6) {
        reader.varint();
        tables.delete(reader.varint());
      } else if (tag === 7) {
        reader.varint();
        tables.add(reader.varint());
        reader.varint();
        reader.field();
        reader.field();
      } else invalid();
    }
  });
  return files.filter((file) => {
    const number = Number(file.split(".")[0]);
    return file.endsWith(".log") ? number >= logNumber || number === previousLog : tables.has(number);
  });
}

async function snapshot(context: Context, path: string, origin: string): Promise<Map<string, string>> {
  let cache = caches.get(context);
  if (!cache) {
    cache = new Map();
    caches.set(context, cache);
  }
  const id = `${path}\n${origin}`,
    cached = cache.get(id);
  if (cached && context.now() - cached.at < 600) return cached.entries;
  const versions = new Map<string, Version>();
  const prefix = Buffer.from(`_${origin}\0`);
  const put = (key: Buffer, sequence: bigint, value: Buffer | null) => {
    if (!key.subarray(0, prefix.length).equals(prefix)) return;
    const name = text(key.subarray(prefix.length));
    if (name === null) return;
    const previous = versions.get(name);
    if (!previous || sequence > previous.sequence) versions.set(name, { sequence, value });
  };
  const names = (await optional(() => context.listDir(path))) ?? [];
  const files = await optional(() => liveFiles(context, path, names));
  let unreadable = false;
  for (const file of files ?? []) {
    if (!/^\d+\.(log|ldb|sst)$/.test(file)) continue;
    const parsed = await optional(async () => {
      const bytes = await context.readFileBytes(`${path}/${file}`);
      if (!bytes || bytes.length > LIMIT) invalid();
      const data = Buffer.from(bytes);
      if (file.endsWith(".log")) log(data, put);
      else table(data, put);
      return true;
    });
    if (!parsed) unreadable = true;
  }
  const result = new Map<string, string>();
  if (unreadable) versions.clear();
  for (const [name, version] of versions) {
    const value = version.value === null ? null : text(version.value);
    if (value !== null) result.set(name, value);
  }
  cache.set(id, { at: context.now(), entries: result });
  return result;
}

/** Returns values from the first matching profile. Never combines accounts across profiles. */
export function browserLocalStorage(context: Context, origin: string, key: string): Promise<string | null>;
export function browserLocalStorage(
  context: Context,
  origin: string,
  key: (key: string) => boolean,
  accept?: (entries: Map<string, string>) => boolean,
): Promise<Map<string, string> | null>;
export async function browserLocalStorage(
  context: Context,
  origin: string,
  key: string | ((key: string) => boolean),
  accept?: (entries: Map<string, string>) => boolean,
): Promise<string | Map<string, string> | null> {
  if (context.platform !== "darwin" && context.platform !== "linux") return null;
  for (const [mac, linux] of browsers) {
    if (context.platform === "linux" && !linux) continue;
    const root =
      context.platform === "darwin"
        ? `${context.home}/Library/Application Support/${mac}`
        : `${context.env.XDG_CONFIG_HOME || `${context.home}/.config`}/${linux}`;
    const names = await optional(() => context.listDir(root));
    if (!names) continue;
    const profiles = names
      .filter((name) => name === "Default" || /^Profile \d+$/.test(name) || /^user-[^/]+$/.test(name))
      .sort();
    profiles.push("");
    for (const profile of profiles) {
      const values = await snapshot(context, `${root}${profile ? `/${profile}` : ""}/Local Storage/leveldb`, origin);
      if (typeof key === "string") {
        const value = values.get(key);
        if (value !== undefined) return value;
      } else {
        const selected = new Map([...values].filter(([name]) => key(name)));
        if (selected.size && (!accept || accept(selected))) return selected;
      }
    }
  }
  return null;
}
