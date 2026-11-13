# AI Usage for BUSY Bar

Shows how much of your AI subscriptions you have used on a [BUSY Bar](https://busy.app): one
account per page, with a bar for each rate-limit window (Claude's 5-hour and weekly limits,
Codex's weekly limit, and so on). A window at its limit shows the time until it resets.

It has two parts:

- **The bar app** (`src/`) runs on the BUSY Bar. It reads a usage feed from up to two places
  and merges them: the file the companion writes into the app's private storage, and an
  optional [CLIProxyAPI hub](#cliproxyapi-hub) on your network.
- **The companion** (`companion/`) runs on your computer. It reads the sign-ins your AI tools
  already have, asks each provider for your usage, and writes the feed to the bar over USB or
  Wi-Fi. Your logins never leave the computer; only percentages and reset times reach the bar.

## Supported providers

The companion supports all 113 providers CodexBar supports, with the same requests and parsing.
For each one it tries CodexBar's sources in CodexBar's order:

- **API keys** from the provider's environment variable (CodexBar's names), the companion's
  config, or CodexBar's config (see [Run the companion](#run-the-companion)).
- **Local logins and files** your tools already have, such as Claude Code's Keychain item,
  `~/.codex/auth.json` or `~/.gemini/oauth_creds.json`. The companion only reads them. It never
  refreshes or rewrites a login another tool owns, because Claude and Codex rotate refresh tokens
  and a second refresher would sign your tools out; when such a token expires, the bar shows
  "sign in" until the tool next runs. Google logins (Gemini, Antigravity, Vertex AI) are the
  exception: their refresh tokens do not rotate, so an expired token is refreshed in memory.
- **The provider's CLI**, for providers whose usage comes from their own command (Kiro, Amp,
  Grok and others). These run at most every 5 minutes.
- **Browser sessions**: a `cookieHeader` saved in the companion's or CodexBar's config, or the
  cookies and localStorage of Chrome-family browsers, Firefox and Safari on this computer. Reading
  Chrome's cookies asks macOS for access to the browser's "Safe Storage" Keychain item once.
  Setting CodexBar's cookie source to Off for a provider turns this off.

A few checks cost money or are slow, so they run less often: Azure OpenAI and Doubao (each check
is a one-token model request) every 15 minutes, and AWS Bedrock (Cost Explorer charges per
request) every hour. Self-hosted gateways (LiteLLM, sub2api, Bifrost and others) need their
address in the provider's environment variable or `enterpriseHost` in the config; requests to
anything other than localhost or a private network must use HTTPS.

| Provider | Id | Reads |
| --- | --- | --- |
| Claude | `claude` | local login or files |
| Codex | `codex` | local login or files |
| Gemini | `gemini` | local login or files |
| Copilot | `copilot` | API key |
| Kimi | `kimi` | API key, local login or files |
| z.ai | `zai` | API key, local login or files |
| MiniMax | `minimax` | API key |
| Synthetic | `synthetic` | API key |
| Warp | `warp` | API key |
| Kilo | `kilo` | API key, local login or files |
| Codebuff | `codebuff` | API key, local login or files |
| Ollama | `ollama` | API key |
| OpenRouter | `openrouter` | API key |
| DeepSeek | `deepseek` | API key |
| Moonshot | `moonshot` | API key |
| Venice | `venice` | API key |
| DeepInfra | `deepinfra` | API key |
| ElevenLabs | `elevenlabs` | API key |
| Abacus | `abacus` | browser session |
| abliteration.ai | `abliteration` | API key |
| Aerostack | `aerostack` | API key |
| ai& | `aiand` | API key |
| Aixy | `aixy` | API key |
| Alibaba | `alibaba` | API key, browser session |
| Alibaba Token Plan | `alibabatokenplan` | its CLI, browser session |
| Amp | `amp` | API key, its CLI, browser session |
| Antigravity | `antigravity` | API key, local login or files, its CLI |
| Atlas Cloud | `atlascloud` | API key |
| Augment | `augment` | its CLI, browser session |
| Azure OpenAI | `azureopenai` | API key |
| Bedrock | `bedrock` | API key, its CLI |
| Bifrost | `bifrost` | API key |
| Chatbox AI | `chatbox` | API key |
| Chutes | `chutes` | API key |
| Claude Platform | `claudeplatform` | browser session |
| ClawRouter | `clawrouter` | API key |
| ClinePass | `clinepass` | API key, local login or files |
| CodeRabbit | `coderabbit` | its CLI |
| Command Code | `commandcode` | API key, browser session |
| Cosmic AI | `cosmic` | API key |
| Cursor | `cursor` | local login or files, browser session |
| Deepgram | `deepgram` | API key |
| Devin | `devin` | local login or files, browser session |
| DevPass | `devpass` | API key |
| Doubao | `doubao` | API key, its CLI |
| Exa | `exa` | API key |
| Factory | `factory` | API key, local login or files, browser session |
| fal | `fal` | API key |
| Fireworks | `fireworks` | API key |
| FLORA | `flora` | API key |
| Future AGI | `futureagi` | API key |
| GitKraken | `gitkraken` | API key |
| Grok | `grok` | API key, local login or files, its CLI, browser session |
| Groq | `groq` | API key, browser session |
| Helmcode | `helmcode` | browser session |
| Hugging Face | `huggingface` | API key, local login or files, browser session |
| Hyper | `hyper` | API key, browser session |
| IBM Bob | `ibmbob` | API key |
| JetBrains | `jetbrains` | local login or files |
| Kiro | `kiro` | local login or files, its CLI |
| Langdock | `langdock` | browser session |
| Linkup | `linkup` | API key |
| LiteLLM | `litellm` | API key |
| LithosAI | `lithosai` | browser session |
| llmman | `llmman` | API key |
| LLM Proxy | `llmproxy` | API key |
| LongCat | `longcat` | browser session |
| Manus | `manus` | browser session |
| MiMo | `mimo` | local login or files, browser session |
| Mistral | `mistral` | browser session |
| Munito | `munito` | API key |
| Muse Code | `muse` | local login or files, browser session |
| Muse | `museai` | browser session |
| Neuralwatt | `neuralwatt` | API key |
| Notion | `notion` | local login or files, browser session |
| Nous | `nous` | API key, local login or files |
| OpenAI | `openai` | API key |
| OpenCode | `opencode` | local login or files, browser session |
| OpenCode Go | `opencodego` | API key, local login or files, browser session |
| OpenDesign | `opendesign` | browser session |
| Parallel | `parallel` | browser session |
| Perplexity | `perplexity` | browser session |
| Pi | `pi` | local login or files |
| Poe | `poe` | API key |
| Qoder | `qoder` | browser session |
| Qwen Cloud | `qwencloud` | browser session |
| Raycast | `raycast` | browser session |
| Replicate | `replicate` | browser session |
| Sail Research | `sailresearch` | API key |
| Sakana | `sakana` | browser session |
| SiliconFlow | `siliconflow` | API key |
| Sofya | `sofya` | API key |
| Soniox | `soniox` | API key |
| StepFun | `stepfun` | API key, browser session |
| sub2api | `sub2api` | API key |
| T3 Chat | `t3chat` | browser session |
| Tavily | `tavily` | API key |
| TinyApi | `tinyapi` | browser session |
| Trae CN | `traecn` | browser session |
| Tripo | `tripo` | API key |
| TypeSafe | `typesafe` | browser session |
| v0 | `v0` | API key |
| Vercel | `vercel` | API key |
| Vertex AI | `vertexai` | local login or files, its CLI |
| Wayfinder | `wayfinder` | local service |
| Windsurf | `windsurf` | local login or files, browser session |
| WorkBuddy | `workbuddy` | local login or files, browser session |
| xAI | `xai` | API key |
| X API | `xapi` | browser session |
| xKiro | `xkiro` | API key |
| Zed | `zed` | local login or files, browser session |
| ZenMux | `zenmux` | API key |
| ZoomMate | `zoommate` | browser session |

The ids match CodexBar's, so CodexBar's documentation for each provider describes the keys,
environment variables and settings it accepts.

## Install the app

With the bar connected over USB:

```sh
nub install
nub run build
nub run app:install
```

Open **AI Usage** from the bar's APPS menu. Turn the wheel to change page, press OK to refresh,
and press Back to leave.

## Run the companion

```sh
cd companion
nub run start                           # the bar over USB (10.0.4.20)
nub run start -- --host 192.168.1.130   # the bar over Wi-Fi
nub run start -- --print --once         # print the feed instead of sending it
```

The bar never connects to the companion. Each minute the companion calls the bar's HTTP API
(over USB at `10.0.4.20`, or the bar's address on your Wi-Fi) and writes the feed into the
app's private storage, where the app reads it. The computer must be able to reach the bar; the
bar needs no route back.

Providers that use an API key look for it, in order, in the provider's environment variable
(such as `OPENROUTER_API_KEY`), in `~/.config/busybar-usage/config.json`, and in CodexBar's
config (`~/.config/codexbar/config.json` or `~/.codexbar/config.json`), so a CodexBar setup
works as it is. The companion's config uses the same field names as CodexBar's provider
entries (`apiKey`, `cookieHeader`, `cookieSource`, `region`, `enterpriseHost` and so on); keep
it private (`chmod 600`):

```json
{
  "providers": {
    "openrouter": { "apiKey": "sk-or-..." },
    "litellm": { "apiKey": "sk-...", "enterpriseHost": "https://litellm.example.com" }
  }
}
```

It updates every minute until stopped. `--providers claude,codex` limits it to some providers;
`--help` lists every option. If the bar has an HTTP access password, set
`BUSYBAR_HTTP_PASSWORD`. The bar only shows the companion's numbers while it runs; keep it
running with launchd or systemd, or use a hub for an always-on source.

## CLIProxyAPI hub

A [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) hub that serves `GET /usage` in
the feed format below (such as the Home Assistant add-on in
[afonsojramos/ha-addons](https://github.com/afonsojramos/ha-addons)) can feed the bar directly,
without a computer. Set **Hub URL** in the app's settings, for example
`http://192.168.1.220:8318/usage`. When the hub and the companion report the same account, the
bar shows the more recent measurement.

## Feed format

```json
{
  "generated_at": "2026-11-13T14:23:09Z",
  "accounts": [
    {
      "provider": "claude",
      "account": "gmail",
      "blocked": false,
      "observed_at": "2026-11-13T14:04:39Z",
      "windows": [{ "name": "5h", "minutes": 300, "used_percent": 16, "resets_at": 1794591000 }],
      "error": "sign in"
    }
  ]
}
```

`account` is a short, non-identifying label: the first part of the login's email domain
(`gmail`, `yld`). `resets_at` is in Unix seconds. `error` is optional and replaces the windows
on the bar. A window with no limit to measure against, such as a prepaid balance, has
`"used_percent": null` and a short `value` (`"$12.40"`) that the bar shows instead of a bar.

## Development

```sh
nub run typecheck   # the app, its tests, and the companion
nub run test        # the app's tests, then the companion's
```

The app runs in the bar's JerryScript runtime, not Node; see [AGENTS.md](AGENTS.md) for its
lifecycle and resource rules. The companion's provider modules take a `Context` with files,
Keychain and `fetch`, so each one is tested against fixtures without real logins.

## Credits

The provider requests follow [CodexBar](https://github.com/steipete/CodexBar) by Peter
Steinberger (MIT). The idea of reading Claude Code's sign-in without refreshing it comes from
[busybar-limits](https://github.com/rbhbokka/busybar-limits).
