import { release } from "node:os";
import { accountLabel, feedWindow, finiteNumber, isoToSeconds, isRecord, valueWindow, type FeedAccount, type FeedWindow } from "../feed.ts";
import { apiKey } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Provider } from "./types.ts";

const QUERY = `query GetRequestLimitInfo($requestContext: RequestContext!) {
  user(requestContext: $requestContext) {
    __typename
    ... on UserOutput {
      user {
        requestLimitInfo {
          isUnlimited
          nextRefreshTime
          requestLimit
          requestsUsedSinceLastRefresh
        }
        bonusGrants {
          requestCreditsGranted
          requestCreditsRemaining
          expiration
        }
        workspaces {
          bonusGrantsInfo {
            grants {
              requestCreditsGranted
              requestCreditsRemaining
              expiration
            }
          }
        }
      }
    }
  }
}`;

function parseUsage(body: unknown, now: number): FeedWindow[] | null {
  if (!isRecord(body) || (Array.isArray(body.errors) && body.errors.length > 0)) return null;
  const data = isRecord(body.data) ? body.data : null;
  const output = data && isRecord(data.user) ? data.user : null;
  const user = output && isRecord(output.user) ? output.user : null;
  const info = user && isRecord(user.requestLimitInfo) ? user.requestLimitInfo : null;
  if (!info || !user) return null;
  const unlimited = info.isUnlimited === true || (typeof info.isUnlimited === "number" && info.isUnlimited !== 0)
    || (typeof info.isUnlimited === "string" && ["true", "1", "yes"].includes(info.isUnlimited.trim().toLowerCase()));
  const limit = finiteNumber(info.requestLimit);
  const used = finiteNumber(info.requestsUsedSinceLastRefresh);
  if (!unlimited && (limit === null || used === null)) return null;
  const windows = [unlimited ? valueWindow("credits", "Unlimited")
    : feedWindow(null, limit !== null && limit > 0 ? Math.min(100, Math.max(0, used ?? 0) / limit * 100) : 0,
      isoToSeconds(info.nextRefreshTime), now, "credits")];
  const grants: unknown[] = Array.isArray(user.bonusGrants) ? [...user.bonusGrants] : [];
  for (const workspace of Array.isArray(user.workspaces) ? user.workspaces : []) {
    const info = isRecord(workspace) && isRecord(workspace.bonusGrantsInfo) ? workspace.bonusGrantsInfo : null;
    if (info && Array.isArray(info.grants)) grants.push(...info.grants);
  }
  let total = 0;
  let remaining = 0;
  for (const grant of grants) {
    if (!isRecord(grant)) continue;
    total += finiteNumber(grant.requestCreditsGranted) ?? 0;
    remaining += finiteNumber(grant.requestCreditsRemaining) ?? 0;
  }
  if (!Number.isFinite(total) || !Number.isFinite(remaining)) return null;
  if (total > 0) windows.push(feedWindow(null, Math.min(100, Math.max(0, (total - remaining) / total * 100)), null, now, "add-on"));
  else if (remaining > 0) windows.push(valueWindow("add-on", `${remaining >= 1000 ? `${(remaining / 1000).toPrecision(3)}k` : remaining} cr`.slice(0, 12)));
  return windows;
}

export const warp: Provider = {
  id: "warp",
  name: "Warp",
  async fetch(context): Promise<FeedAccount[]> {
    const key = await apiKey(context, "warp", ["WARP_API_KEY", "WARP_TOKEN"]);
    if (!key) throw new NotConfigured("Warp");
    const now = context.now();
    const base: FeedAccount = { provider: "warp", account: accountLabel(null), blocked: false,
      observed_at: new Date(now * 1000).toISOString(), windows: [] };
    const version = release();
    const response = await context.fetch("https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json",
        "x-warp-client-id": "warp-app", "x-warp-os-category": "macOS", "x-warp-os-name": "macOS",
        "x-warp-os-version": version, "User-Agent": "Warp/1.0" },
      body: JSON.stringify({ query: QUERY, variables: { requestContext: { clientContext: {},
        osContext: { category: "macOS", name: "macOS", version } } }, operationName: "GetRequestLimitInfo" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) return [{ ...base, error: "sign in" }];
    if (response.status === 429) throw new RateLimited("Warp", now + retryAfterSeconds(response.headers, 300));
    if (!response.ok) throw new HttpError("Warp", response.status);
    let body: unknown;
    try { body = await response.json(); } catch { throw new HttpError("Warp", response.status); }
    const windows = parseUsage(body, now);
    if (!windows) throw new HttpError("Warp", response.status);
    return [{ ...base, windows, blocked: windows.some((w) => (w.used_percent ?? 0) >= 100) }];
  },
};
