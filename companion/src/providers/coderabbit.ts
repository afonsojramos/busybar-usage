import { accountLabel, valueWindow, type FeedAccount } from "../feed.ts";
import { HttpError, NotConfigured, type Provider } from "./types.ts";

export const coderabbit: Provider = {
  id: "coderabbit",
  name: "CodeRabbit",
  async fetch(context) {
    const result = await context.run(context.env.CODERABBIT_CLI_PATH || "coderabbit", ["usage"], {
      timeoutMs: 15_000,
      env: { CODERABBIT_CLI_DISABLE_AUTO_UPDATE: "true", NO_COLOR: "1" },
    });
    if (!result) throw new NotConfigured("CodeRabbit");
    const base: FeedAccount = {
      provider: "coderabbit", account: accountLabel(null), blocked: false,
      observed_at: new Date(context.now() * 1000).toISOString(), windows: [],
    };
    const text = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    if (/not authenticated|please log in|auth login|authentication required|unauthorized|no session found/i.test(text)) {
      return [{ ...base, error: "sign in" }];
    }
    if (result.code !== 0) throw new HttpError("CodeRabbit", 502);
    const fields = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([^:]+):\s*(.+)$/);
      if (match && !fields.has(match[1].toLowerCase().trim())) {
        fields.set(match[1].toLowerCase().trim(), match[2].trim());
      }
    }
    const reviews = fields.get("your reviews");
    const validReviews = reviews !== undefined && /^\d+$/.test(reviews) && Number.isSafeInteger(Number(reviews));
    if (!validReviews && !fields.has("usage billing") && !fields.has("period resets")) {
      throw new HttpError("CodeRabbit", 200);
    }
    if (validReviews) base.windows.push(valueWindow("reviews", (Number(reviews) < 1e9 ? Number(reviews).toLocaleString("en-US") : Number(reviews).toExponential(1))));
    return [base];
  },
};
