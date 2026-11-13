import { claude } from "./claude.ts";
import { codebuff } from "./codebuff.ts";
import { codex } from "./codex.ts";
import { copilot } from "./copilot.ts";
import { deepinfra } from "./deepinfra.ts";
import { deepseek } from "./deepseek.ts";
import { elevenlabs } from "./elevenlabs.ts";
import { gemini } from "./gemini.ts";
import { kilo } from "./kilo.ts";
import { kimi } from "./kimi.ts";
import { minimax } from "./minimax.ts";
import { moonshot } from "./moonshot.ts";
import { ollama } from "./ollama.ts";
import { openrouter } from "./openrouter.ts";
import { synthetic } from "./synthetic.ts";
import type { Provider } from "./types.ts";
import { venice } from "./venice.ts";
import { warp } from "./warp.ts";
import { zai } from "./zai.ts";

/** Every provider the companion knows: coding subscriptions first, then API balances. */
export const providers: Provider[] = [
  claude,
  codex,
  gemini,
  copilot,
  kimi,
  zai,
  minimax,
  synthetic,
  warp,
  kilo,
  codebuff,
  ollama,
  openrouter,
  deepseek,
  moonshot,
  venice,
  deepinfra,
  elevenlabs,
];
