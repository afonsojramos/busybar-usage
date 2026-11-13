import { accountLabel, isRecord, type FeedAccount } from "../feed.ts";
import { apiKey, providerEntry } from "../keys.ts";
import { HttpError, NotConfigured, RateLimited, retryAfterSeconds, type Context, type Provider } from "./types.ts";

const ID = "azureopenai";

function base(context: Context): FeedAccount {
  return {
    provider: ID,
    account: accountLabel(null),
    blocked: false,
    observed_at: new Date(context.now() * 1000).toISOString(),
    windows: [],
  };
}

function signIn(context: Context, error: unknown): FeedAccount[] {
  if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
    return [{ ...base(context), error: "sign in" }];
  }
  throw error;
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(ID, 200);
  return value;
}

export const azureopenai: Provider = {
  id: ID,
  name: "Azure OpenAI",
  // Its only check is a chat completion, which Azure bills.
  minIntervalSeconds: 900,
  async fetch(context) {
    const key = await apiKey(context, ID, ["AZURE_OPENAI_API_KEY"]);
    const entry = await providerEntry(context, ID);
    const raw = context.env.AZURE_OPENAI_ENDPOINT || entry.enterpriseHost;
    const deployment = context.env.AZURE_OPENAI_DEPLOYMENT_NAME || entry.workspaceID;
    if (!key || typeof raw !== "string" || typeof deployment !== "string" || !deployment.trim())
      throw new NotConfigured(ID);
    let url: URL;
    try {
      url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    } catch {
      throw new NotConfigured(ID);
    }
    const privateHost =
      /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/.test(
        url.hostname,
      );
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && privateHost)) || url.username || url.password)
      throw new NotConfigured(ID);
    const configured = typeof entry.azureOpenAIAPIVersion === "string" ? entry.azureOpenAIAPIVersion.trim() : "";
    const version = configured || context.env.AZURE_OPENAI_API_VERSION?.trim() || "2024-10-21";
    const path = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    if (version === "v1") url.pathname = `${path.replace(/\/openai(?:\/v1)?$/, "")}/openai/v1/chat/completions`;
    else {
      url.pathname = `${path.replace(/\/openai$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`;
      url.searchParams.set("api-version", version);
    }
    try {
      const response = await context.fetch(url, {
        method: "POST",
        redirect: "error",
        headers: { "api-key": key, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "ping" }],
          ...(version === "v1" ? { model: deployment, max_completion_tokens: 64 } : { max_tokens: 1 }),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429) throw new RateLimited(ID, context.now() + retryAfterSeconds(response.headers, 300));
      if (!response.ok) throw new HttpError(ID, response.status);
      try {
        object(await response.json());
      } catch {
        throw new HttpError(ID, response.status);
      }
      // CodexBar validates the deployment; this source exposes no historical usage or quota.
      return [{ ...base(context), error: "no quota" }];
    } catch (error) {
      return signIn(context, error);
    }
  },
};
