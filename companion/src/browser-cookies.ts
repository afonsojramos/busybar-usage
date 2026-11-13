import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import type { Context } from "./providers/types.ts";

const chromiumSql = "SELECT host_key, name, value, encrypted_value, expires_utc, path FROM cookies";
const versionSql = "SELECT value FROM meta WHERE key = 'version'";
const firefoxSql = "SELECT host, name, value, expiry, path FROM moz_cookies";
const chromiumEpoch = 11644473600;

// Profile roots and Safe Storage identities, rather than application bundle names.
export const browsers = [
  ["Google/Chrome", "google-chrome", "Chrome"],
  ["BraveSoftware/Brave-Browser", "BraveSoftware/Brave-Browser", "Brave"],
  ["Microsoft Edge", "microsoft-edge", "Microsoft Edge"],
  ["Arc/User Data", "", "Arc"],
  ["Vivaldi", "vivaldi", "Vivaldi"],
  ["Chromium", "chromium", "Chromium"],
  ["Google/Chrome Beta", "google-chrome-beta", "Chrome"],
  ["Google/Chrome Canary", "google-chrome-unstable", "Chrome"],
  ["BraveSoftware/Brave-Browser-Beta", "BraveSoftware/Brave-Browser-Beta", "Brave"],
  ["BraveSoftware/Brave-Browser-Nightly", "BraveSoftware/Brave-Browser-Nightly", "Brave"],
  ["BraveSoftware/Brave-Browser-Origin", "", "Brave"],
  ["com.operasoftware.Opera", "opera", "Opera"],
  ["com.operasoftware.OperaGX", "", "Opera"],
  ["company.thebrowser.dia", "", "Dia"],
  ["Comet", "", "Comet"],
  ["Yandex/YandexBrowser", "yandex-browser", "Yandex"],
  ["net.imput.helium", "helium", "Helium"],
  ["Orion", "", "Orion"],
];

interface Cookie {
  host: string;
  name: string;
  value: string;
  expires: number;
  path: string;
}

/** Browser stores are copied and decrypted at most this often per domain set. */
const CACHE_SECONDS = 600;

interface Cache {
  headers: Map<string, { header: string | null; at: number }>;
  /** Derived Safe Storage keys per browser, so the Keychain is asked once per run. */
  keys: Map<string, Buffer | null>;
}

const caches = new WeakMap<Context, Cache>();

function cacheFor(context: Context): Cache {
  let cache = caches.get(context);
  if (!cache) {
    cache = { headers: new Map(), keys: new Map() };
    caches.set(context, cache);
  }
  return cache;
}

async function optional<T>(work: () => Promise<T>): Promise<T | null> {
  try { return await work(); } catch { return null; }
}

function matches(host: string, domains: string[]): boolean {
  const lower = host.toLowerCase();
  return domains.some((domain) => {
    const target = domain.toLowerCase().replace(/^\./, "");
    return lower.startsWith(".")
      ? target === lower.slice(1) || target.endsWith(lower)
      : target === lower;
  });
}

function header(cookies: Cookie[], domains: string[], required: string[], now: number): string | null {
  const selected = cookies.filter((cookie) => matches(cookie.host, domains) &&
    Number.isFinite(cookie.expires) && (cookie.expires === 0 || cookie.expires > now) &&
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) && !/[\x00-\x20\x7f;]/.test(cookie.value));
  if (!selected.length || !required.every((name) => selected.some((cookie) => cookie.name === name))) return null;
  return selected.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

async function chromium(context: Context, root: string, identity: string, domains: string[], required: string[]) {
  const entries = await optional(() => context.listDir(root));
  if (!entries) return null;
  const profiles = entries.filter((name) => name === "Default" || /^Profile \d+$/.test(name) || /^user-[^/]+$/.test(name)).sort();
  // Opera and some Chromium derivatives keep their store directly in the root.
  profiles.push("");
  const keys = cacheFor(context).keys;
  let key: Buffer | null | undefined = keys.get(identity);
  for (const profile of profiles) {
    const base = profile ? `${root}/${profile}` : root;
    const merged = new Map<string, Cookie>();
    for (const suffix of ["Network/Cookies", "Cookies"]) {
      const db = `${base}/${suffix}`;
      const rows = await optional(() => context.querySqlite(db, chromiumSql));
      if (!rows?.length) continue;
      const meta = await optional(() => context.querySqlite(db, versionSql));
      const version = Number(meta?.[0]?.value ?? 0);
      for (const row of rows) {
        if (typeof row.host_key !== "string" || typeof row.name !== "string" || !matches(row.host_key, domains)) continue;
        let value = typeof row.value === "string" ? row.value : "";
        const encrypted = row.encrypted_value;
        if (encrypted instanceof Uint8Array && encrypted.length) {
          // Linux v11 requires Secret Service; v20/app-bound encryption is unsupported too.
          if (Buffer.from(encrypted.subarray(0, 3)).toString() !== "v10") continue;
          if (key === undefined) {
            const password = context.platform === "linux" ? "peanuts" :
              await optional(() => context.readKeychain(`${identity} Safe Storage`, identity));
            key = password === null ? null : pbkdf2Sync(password, "saltysalt", context.platform === "linux" ? 1 : 1003, 16, "sha1");
            keys.set(identity, key);
          }
          if (!key) continue;
          try {
            const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 32));
            let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
            if (version >= 24) {
              if (plain.length < 32 || !plain.subarray(0, 32).equals(createHash("sha256").update(row.host_key).digest())) continue;
              plain = plain.subarray(32);
            }
            value = new TextDecoder("utf-8", { fatal: true }).decode(plain);
          } catch { continue; }
        } else if (typeof row.value !== "string") continue;
        const expires = Number(row.expires_utc);
        const cookie = { host: row.host_key, name: row.name, value,
          expires: expires === 0 ? 0 : expires / 1e6 - chromiumEpoch,
          path: typeof row.path === "string" ? row.path : "/" };
        const id = `${cookie.host}\n${cookie.path}\n${cookie.name}`;
        const existing = merged.get(id);
        if (!existing || cookie.expires > existing.expires) merged.set(id, cookie);
      }
    }
    const result = header([...merged.values()], domains, required, context.now());
    if (result) return result;
  }
  return null;
}

async function firefox(context: Context, root: string, domains: string[], required: string[]) {
  const ini = await optional(() => context.readFile(`${root}/profiles.ini`));
  const profiles: string[] = [];
  for (const section of (ini ?? "").split(/^\s*\[/m)) {
    if (!/^Profile[^\]]*\]/.test(section)) continue;
    const path = /^Path\s*=\s*(.+)$/m.exec(section)?.[1]?.trim();
    if (!path) continue;
    profiles.push(/^IsRelative\s*=\s*0\s*$/m.test(section) ? path : `${root}/${path}`);
  }
  const entries = await optional(() => context.listDir(`${root}/Profiles`));
  for (const entry of entries ?? []) {
    if (!entry.includes("/")) profiles.push(`${root}/Profiles/${entry}`);
  }
  for (const profile of new Set(profiles)) {
    const rows = await optional(() => context.querySqlite(`${profile}/cookies.sqlite`, firefoxSql));
    const cookies: Cookie[] = [];
    for (const row of rows ?? []) {
      if (typeof row.host !== "string" || typeof row.name !== "string" || typeof row.value !== "string") continue;
      cookies.push({ host: row.host, name: row.name, value: row.value, expires: Number(row.expiry),
        path: typeof row.path === "string" ? row.path : "/" });
    }
    const result = header(cookies, domains, required, context.now());
    if (result) return result;
  }
  return null;
}

function safari(bytes: Uint8Array): Cookie[] {
  const data = Buffer.from(bytes);
  if (data.length < 8 || data.toString("ascii", 0, 4) !== "cook") return [];
  const count = data.readUInt32BE(4);
  if (count > (data.length - 8) / 4) return [];
  let start = 8 + count * 4;
  const cookies: Cookie[] = [];
  for (let pageIndex = 0; pageIndex < count; pageIndex++) {
    const size = data.readUInt32BE(8 + pageIndex * 4);
    if (size < 12 || start + size > data.length) break;
    const page = data.subarray(start, start + size);
    start += size;
    if (page.readUInt32BE(0) !== 0x100) continue;
    const records = page.readUInt32LE(4);
    if (records > (size - 12) / 4) continue;
    for (let i = 0; i < records; i++) {
      const offset = page.readUInt32LE(8 + i * 4);
      if (offset + 56 > page.length) continue;
      const length = page.readUInt32LE(offset);
      if (length < 56 || offset + length > page.length) continue;
      const record = page.subarray(offset, offset + length);
      const stringAt = (field: number): string | null => {
        const position = record.readUInt32LE(field);
        if (position < 56 || position >= length) return null;
        const end = record.indexOf(0, position);
        return end < 0 ? null : record.toString("utf8", position, end);
      };
      const host = stringAt(16), name = stringAt(20), path = stringAt(24), value = stringAt(28);
      if (host === null || name === null || path === null || value === null) continue;
      cookies.push({ host, name, path, value, expires: record.readDoubleLE(40) + 978307200 });
    }
  }
  return cookies;
}

/** Returns the first complete browser-profile session, without combining accounts across profiles. */
export async function browserCookieHeader(context: Context, domains: string[], required: string[]): Promise<string | null> {
  if (!domains.length || (context.platform !== "darwin" && context.platform !== "linux")) return null;
  const cache = cacheFor(context).headers;
  const id = `${domains.join(",")}|${required.join(",")}`;
  const cached = cache.get(id);
  if (cached && context.now() - cached.at < CACHE_SECONDS) return cached.header;
  const header = await readBrowsers(context, domains, required);
  cache.set(id, { header, at: context.now() });
  return header;
}

async function readBrowsers(context: Context, domains: string[], required: string[]): Promise<string | null> {
  for (const [mac, linux, identity] of browsers) {
    if (context.platform === "linux" && !linux) continue;
    const root = context.platform === "darwin" ? `${context.home}/Library/Application Support/${mac}` :
      `${context.env.XDG_CONFIG_HOME || `${context.home}/.config`}/${linux}`;
    const result = await optional(() => chromium(context, root, identity, domains, required));
    if (result) return result;
  }
  for (const folder of context.platform === "darwin" ? ["Firefox", "Zen", "Floorp", "LibreWolf"] : []) {
    const result = await optional(() => firefox(context, `${context.home}/Library/Application Support/${folder}`, domains, required));
    if (result) return result;
  }
  if (context.platform === "linux") return optional(() => firefox(context, `${context.home}/.mozilla/firefox`, domains, required));
  for (const path of ["Library/Cookies/Cookies.binarycookies",
    "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"]) {
    const result = await optional(async () => {
      const bytes = await context.readFileBytes(`${context.home}/${path}`);
      return bytes ? header(safari(bytes), domains, required, context.now()) : null;
    });
    if (result) return result;
  }
  return null;
}
