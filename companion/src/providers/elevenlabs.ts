import {
  accountLabel,
  feedWindow,
  finiteNumber,
  isRecord,
  valueWindow,
  type FeedAccount,
  type FeedWindow,
} from "../feed.ts";
import { apiKey } from "../keys.ts";
import {
  HttpError,
  NotConfigured,
  RateLimited,
  retryAfterSeconds,
  type Provider,
  isProviderHost,
  type RequestOptions,
} from "./types.ts";

function apiBase(raw: string | undefined, fallback: string): string {
  try {
    const text = raw?.trim() || fallback;
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    if (!isProviderHost(url, ["api.elevenlabs.io"]) || url.username || url.password || url.search || url.hash)
      throw new Error();
    return url.href.replace(/\/+$/, "");
  } catch {
    throw new HttpError("ElevenLabs", 0);
  }
}

const SIGN_IN = Symbol("sign in");

export const elevenlabs: Provider = {
  id: "elevenlabs",
  name: "ElevenLabs",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "elevenlabs", ["ELEVENLABS_API_KEY", "XI_API_KEY"]);
    if (!key) throw new NotConfigured("ElevenLabs");
    const now = context.now();
    const base: FeedAccount = {
      provider: "elevenlabs",
      account: accountLabel(null),
      blocked: false,
      observed_at: new Date(now * 1000).toISOString(),
      windows: [],
    };
    const headers: Record<string, string> = { "xi-api-key": key, Accept: "application/json" };
    async function request(url: string, init: RequestOptions = {}): Promise<unknown> {
      const response = await context.fetch(url, {
        ...init,
        headers: { ...headers, ...init.headers },
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 401 || response.status === 403) return SIGN_IN;
      if (response.status === 429) throw new RateLimited("ElevenLabs", now + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError("ElevenLabs", response.status);
      try {
        return await response.json();
      } catch {
        throw new HttpError("ElevenLabs", response.status);
      }
    }
    const url = `${apiBase(context.env.ELEVENLABS_API_URL, "https://api.elevenlabs.io")}/v1/user/subscription`;
    const data = await request(url);
    if (data === SIGN_IN) return [{ ...base, error: "sign in" }];
    if (!isRecord(data)) throw new HttpError("ElevenLabs", 200);
    const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
    if (!integer(data.character_count) || !integer(data.character_limit)) throw new HttpError("ElevenLabs", 200);
    for (const key of [
      "voice_slots_used",
      "voice_limit",
      "professional_voice_slots_used",
      "professional_voice_limit",
      "next_character_count_reset_unix",
    ]) {
      if (data[key] != null && !integer(data[key])) throw new HttpError("ElevenLabs", 200);
    }
    if ([data.tier, data.status].some((value) => value != null && typeof value !== "string")) {
      throw new HttpError("ElevenLabs", 200);
    }
    if (
      data.current_overage != null &&
      (!isRecord(data.current_overage) ||
        [data.current_overage.amount, data.current_overage.currency].some(
          (value) => value != null && typeof value !== "string",
        ))
    )
      throw new HttpError("ElevenLabs", 200);
    const windows: FeedWindow[] =
      data.character_limit > 0
        ? [
            feedWindow(
              43200,
              Math.min(100, Math.max(0, (data.character_count / data.character_limit) * 100)),
              finiteNumber(data.next_character_count_reset_unix),
              now,
            ),
          ]
        : [valueWindow("chars", `${data.character_count.toExponential(1)} cr`)];
    const voices = finiteNumber(data.voice_slots_used);
    const limit = finiteNumber(data.voice_limit);
    if (voices !== null && limit !== null && limit > 0) {
      windows.push(feedWindow(null, Math.min(100, Math.max(0, (voices / limit) * 100)), null, now, "voice"));
    }
    return [{ ...base, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100), windows }];
  },
};
