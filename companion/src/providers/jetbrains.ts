import { join } from "node:path";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedWindow } from "../feed.ts";
import { providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, type Provider } from "./types.ts";

function json(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try { const value: unknown = JSON.parse(text); return isRecord(value) ? value : null; } catch { return null; }
}

function quotaWindows(quota: Record<string, unknown>, refill: Record<string, unknown> | null, now: number): FeedWindow[] | null {
  const tariff = isRecord(quota.tariffQuota) && finiteNumber(quota.tariffQuota.current) !== null
    && finiteNumber(quota.tariffQuota.maximum) !== null ? quota.tariffQuota : quota;
  const used = finiteNumber(tariff.current); const maximum = finiteNumber(tariff.maximum);
  if (used === null || used < 0 || maximum === null || maximum <= 0) return null;
  const duration = refill?.duration ?? (isRecord(refill?.tariff) ? refill.tariff.duration : null);
  const hours = typeof duration === "string" ? finiteNumber(duration.match(/^PT([\d.]+)H$/)?.[1]) : null;
  const minutes = hours !== null ? hours * 60 : duration === "monthly" || duration === "30d" ? 43200 : null;
  const windows = [feedWindow(minutes, used / maximum * 100, isoToSeconds(refill?.next), now, minutes === null ? "quota" : undefined)];
  if (isRecord(quota.topUpQuota)) {
    const cap = finiteNumber(quota.topUpQuota.maximum); const available = finiteNumber(quota.topUpQuota.available);
    if (cap !== null && cap > 0 && available !== null && available >= 0) {
      const credits = Math.min(available, cap) / 100000;
      windows.push(valueWindow("topup", `${credits < 1e7 ? credits.toFixed(2) : credits.toExponential(1)} cr`));
    }
  }
  return windows;
}

export function parseJetBrainsXML(text: string, now: number): FeedWindow[] | null {
  const component = text.match(/<component\b[^>]*name\s*=\s*["']AIAssistantQuotaManager2["'][^>]*>[\s\S]*?<\/component>/)?.[0];
  if (!component) return null;
  const options = new Map<string, string>();
  const decode = (value: string) => value.replace(/&#10;/g, "\n").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  for (const tag of component.matchAll(/<option\b[^>]*>/g)) {
    const attributes = new Map([...tag[0].matchAll(/([\w]+)\s*=\s*(["'])(.*?)\2/gs)].map(m => [m[1], decode(m[3])]));
    const name = attributes.get("name"); const value = attributes.get("value");
    if (name && value) options.set(name, value);
  }
  const quota = json(options.get("quotaInfo"));
  return quota ? quotaWindows(quota, json(options.get("nextRefill")), now) : null;
}

export function parseJetBrainsLog(text: string, now: number): FeedWindow[] | null {
  if (!text.endsWith("\n")) return null;
  let refill: Record<string, unknown> | null = null;
  for (const line of text.slice(-4 * 1024 * 1024).split("\n").reverse()) {
    if (line.includes("QuotaManager2Impl - New quota refill state is:")) {
      const next = line.match(/\bnext=([^,)\s]+)/)?.[1];
      const duration = line.match(/\b(?:duration|period)=([^,)\s]+)/)?.[1];
      if (!refill) refill = { next, duration };
    }
    if (line.includes("AiaActivationTransmitter - Received message from junie: quota_update:")) {
      const payload = json(line.split("quota_update:")[1]?.trim());
      if (!payload || !isRecord(payload.tariffQuota)) return null;
      const convert = (details: Record<string, unknown>) => Object.fromEntries(Object.entries(details)
        .map(([key, value]) => [key, isRecord(value) ? value.amount : null]));
      return quotaWindows({ ...payload, tariffQuota: convert(payload.tariffQuota),
        topUpQuota: isRecord(payload.topUpQuota) ? convert(payload.topUpQuota) : null }, refill, now);
    }
    if (line.includes("QuotaManager2Impl - New quota state is:")) {
      if (line.includes("Error(exception=com.intellij.ml.llm.core.AIAssistantForbiddenException")) continue;
      if (!line.includes("Available(")) return null;
      const details = (label: string) => {
        const match = line.match(new RegExp(`${label}=(?:QuotaDetails|Details)\\(current=([\\d.eE+-]+), maximum=([\\d.eE+-]+), available=([\\d.eE+-]+)\\)`));
        return match ? { current: match[1], maximum: match[2], available: match[3] } : null;
      };
      const tariff = details("tariffQuota");
      return tariff ? quotaWindows({ tariffQuota: tariff, topUpQuota: details("topUpQuota") }, refill, now) : null;
    }
  }
  return null;
}

export const jetbrains: Provider = {
  id: "jetbrains", name: "JetBrains",
  async fetch(context) {
    const entry = await providerEntry(context, "jetbrains");
    const override = entry.jetbrainsIDEBasePath;
    const roots = context.platform === "darwin" ? ["Library/Application Support/JetBrains", "Library/Application Support/Google"]
      : [".config/JetBrains", ".local/share/JetBrains", ".config/Google"];
    const paths: string[] = [];
    if (typeof override === "string" && override.trim()) paths.push(override.startsWith("~/") ? join(context.home, override.slice(2)) : override);
    else for (const root of roots) {
      const directory = join(context.home, root);
      const entries = await context.listDir(directory);
      for (const name of (entries ?? []).sort((a, b) => b.localeCompare(a, "en", { numeric: true }))) {
        if (/^(IntelliJIdea|PyCharm|WebStorm|GoLand|CLion|DataGrip|RubyMine|Rider|PhpStorm|AppCode|Fleet|AndroidStudio|RustRover|Aqua|DataSpell)/i.test(name)
          && !name.includes("/") && !name.includes("\\")) paths.push(join(directory, name));
      }
    }
    const xmlByPath = new Map<string, string>();
    for (const path of paths) {
      const xml = await context.readFile(join(path, "options/AIAssistantQuotaManager2.xml"));
      if (xml !== null) xmlByPath.set(path, xml);
    }
    if (typeof override !== "string" && xmlByPath.size > 1) throw new NotConfigured("JetBrains");
    let found = false;
    for (const path of xmlByPath.size ? [...xmlByPath.keys()] : paths) {
      const xml = xmlByPath.get(path) ?? null;
      if (xml !== null) found = true;
      let windows = xml === null ? null : parseJetBrainsXML(xml, context.now());
      // File mtimes are unavailable in Context; use logs only when XML cannot provide a quota.
      if (!windows) {
        for (const root of roots) {
          const parent = join(context.home, root);
          if (!path.startsWith(`${parent}/`) || path.slice(parent.length + 1).includes("/")) continue;
          const vendor = root.endsWith("Google") ? "Google" : "JetBrains";
          const logPath = context.platform === "darwin" ? join(context.home, "Library/Logs", vendor, path.slice(parent.length + 1), "idea.log")
            : join(context.home, ".cache", vendor, path.slice(parent.length + 1), "log/idea.log");
          const log = await context.readFile(logPath);
          if (log !== null) { found = true; windows = parseJetBrainsLog(log, context.now()); }
        }
      }
      if (windows) return [{ provider: "jetbrains", account: accountLabel(null), windows,
        observed_at: new Date(context.now() * 1000).toISOString(), blocked: windows.some(w => (w.used_percent ?? 0) >= 100) }];
      if (xml !== null) throw new HttpError("JetBrains", 200);
    }
    if (found) throw new HttpError("JetBrains", 200);
    throw new NotConfigured("JetBrains");
  },
};
