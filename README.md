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

The companion reads logins your tools already have, or API keys (see
[Run the companion](#run-the-companion) for where it looks). It never refreshes or rewrites a
login another tool owns, because Claude and Codex rotate refresh tokens and a second refresher
would sign your tools out; when such a token expires, the bar shows "sign in" until the tool
next runs. Gemini is the exception: Google refresh tokens do not rotate, so the companion
refreshes an expired Gemini token in memory and never writes it back.

| Provider | Reads | Shows |
| --- | --- | --- |
| Claude | Claude Code's login (`Claude Code-credentials` Keychain item on macOS, `~/.claude/.credentials.json` elsewhere) | 5-hour and weekly limits |
| Codex | `~/.codex/auth.json` (a ChatGPT login) | 5-hour and weekly limits |
| Gemini | `~/.gemini/oauth_creds.json` from the Gemini CLI | daily Pro and Flash quotas |
| Copilot | the token CodexBar saves with `codexbar config login --provider copilot` | premium requests and chat |
| Kimi | `KIMI_CODE_API_KEY`, or the Kimi CLI's login | 5-hour, weekly and monthly limits |
| z.ai | `Z_AI_API_KEY` | Coding Plan limits |
| MiniMax | `MINIMAX_API_KEY` | Coding Plan limits |
| Synthetic | `SYNTHETIC_API_KEY` | weekly credits |
| Warp | `WARP_API_KEY` | monthly credits |
| Kilo | `KILO_API_KEY`, or the Kilo CLI's login | Kilo Pass and credits |
| Codebuff | `CODEBUFF_API_KEY`, or `~/.config/manicode/credentials.json` | weekly and credit quotas |
| Ollama Cloud | `OLLAMA_API_KEY` | usage limits or balance |
| OpenRouter | `OPENROUTER_API_KEY` | spending cap and balance |
| DeepSeek | `DEEPSEEK_API_KEY` | balance |
| Moonshot | `MOONSHOT_API_KEY` | balance |
| Venice | `VENICE_API_KEY` | DIEM and USD balance |
| DeepInfra | `DEEPINFRA_API_KEY` | billing quota and balance |
| ElevenLabs | `ELEVENLABS_API_KEY` | character quota |

Each provider also accepts its key from the config files below, and from the alternative
environment variable names CodexBar accepts. Requests and parsing follow CodexBar; sources that
need a browser session (cookies) are not supported.

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

Providers that use an API key look for it, in order, in the provider's environment variable
(such as `OPENROUTER_API_KEY`), in `~/.config/busybar-usage/config.json`, and in CodexBar's
config (`~/.config/codexbar/config.json` or `~/.codexbar/config.json`), so a CodexBar setup
works as it is. The companion's config looks like this; keep it private (`chmod 600`):

```json
{ "providers": { "openrouter": { "apiKey": "sk-or-..." } } }
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
