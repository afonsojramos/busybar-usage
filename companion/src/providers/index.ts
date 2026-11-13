import { abacus } from "./abacus.ts";
import { abliteration } from "./abliteration.ts";
import { aerostack } from "./aerostack.ts";
import { aiand } from "./aiand.ts";
import { aixy } from "./aixy.ts";
import { alibaba } from "./alibaba.ts";
import { alibabatokenplan } from "./alibabatokenplan.ts";
import { amp } from "./amp.ts";
import { antigravity } from "./antigravity.ts";
import { atlascloud } from "./atlascloud.ts";
import { augment } from "./augment.ts";
import { azureopenai } from "./azureopenai.ts";
import { bedrock } from "./bedrock.ts";
import { bifrost } from "./bifrost.ts";
import { chatbox } from "./chatbox.ts";
import { chutes } from "./chutes.ts";
import { claude } from "./claude.ts";
import { claudeplatform } from "./claudeplatform.ts";
import { clawrouter } from "./clawrouter.ts";
import { clinepass } from "./clinepass.ts";
import { codebuff } from "./codebuff.ts";
import { coderabbit } from "./coderabbit.ts";
import { codex } from "./codex.ts";
import { commandcode } from "./commandcode.ts";
import { copilot } from "./copilot.ts";
import { cosmic } from "./cosmic.ts";
import { cursor } from "./cursor.ts";
import { deepgram } from "./deepgram.ts";
import { deepinfra } from "./deepinfra.ts";
import { deepseek } from "./deepseek.ts";
import { devin } from "./devin.ts";
import { devpass } from "./devpass.ts";
import { doubao } from "./doubao.ts";
import { elevenlabs } from "./elevenlabs.ts";
import { exa } from "./exa.ts";
import { factory } from "./factory.ts";
import { fal } from "./fal.ts";
import { fireworks } from "./fireworks.ts";
import { flora } from "./flora.ts";
import { futureagi } from "./futureagi.ts";
import { gemini } from "./gemini.ts";
import { gitkraken } from "./gitkraken.ts";
import { grok } from "./grok.ts";
import { groq } from "./groq.ts";
import { helmcode } from "./helmcode.ts";
import { huggingface } from "./huggingface.ts";
import { hyper } from "./hyper.ts";
import { ibmbob } from "./ibmbob.ts";
import { jetbrains } from "./jetbrains.ts";
import { kilo } from "./kilo.ts";
import { kimi } from "./kimi.ts";
import { kiro } from "./kiro.ts";
import { langdock } from "./langdock.ts";
import { linkup } from "./linkup.ts";
import { litellm } from "./litellm.ts";
import { lithosai } from "./lithosai.ts";
import { llmman } from "./llmman.ts";
import { llmproxy } from "./llmproxy.ts";
import { longcat } from "./longcat.ts";
import { manus } from "./manus.ts";
import { mimo } from "./mimo.ts";
import { minimax } from "./minimax.ts";
import { mistral } from "./mistral.ts";
import { moonshot } from "./moonshot.ts";
import { munito } from "./munito.ts";
import { muse } from "./muse.ts";
import { museai } from "./museai.ts";
import { neuralwatt } from "./neuralwatt.ts";
import { notion } from "./notion.ts";
import { nous } from "./nous.ts";
import { ollama } from "./ollama.ts";
import { openai } from "./openai.ts";
import { opencode } from "./opencode.ts";
import { opencodego } from "./opencodego.ts";
import { opendesign } from "./opendesign.ts";
import { openrouter } from "./openrouter.ts";
import { parallel } from "./parallel.ts";
import { perplexity } from "./perplexity.ts";
import { pi } from "./pi.ts";
import { poe } from "./poe.ts";
import { qoder } from "./qoder.ts";
import { qwencloud } from "./qwencloud.ts";
import { raycast } from "./raycast.ts";
import { replicate } from "./replicate.ts";
import { sailresearch } from "./sailresearch.ts";
import { sakana } from "./sakana.ts";
import { siliconflow } from "./siliconflow.ts";
import { sofya } from "./sofya.ts";
import { soniox } from "./soniox.ts";
import { stepfun } from "./stepfun.ts";
import { sub2api } from "./sub2api.ts";
import { synthetic } from "./synthetic.ts";
import { t3chat } from "./t3chat.ts";
import { tavily } from "./tavily.ts";
import { tinyapi } from "./tinyapi.ts";
import { traecn } from "./traecn.ts";
import { tripo } from "./tripo.ts";
import type { Provider } from "./types.ts";
import { typesafe } from "./typesafe.ts";
import { v0 } from "./v0.ts";
import { venice } from "./venice.ts";
import { vercel } from "./vercel.ts";
import { vertexai } from "./vertexai.ts";
import { warp } from "./warp.ts";
import { wayfinder } from "./wayfinder.ts";
import { windsurf } from "./windsurf.ts";
import { workbuddy } from "./workbuddy.ts";
import { xai } from "./xai.ts";
import { xapi } from "./xapi.ts";
import { xkiro } from "./xkiro.ts";
import { zai } from "./zai.ts";
import { zed } from "./zed.ts";
import { zenmux } from "./zenmux.ts";
import { zoommate } from "./zoommate.ts";

/** Every provider the companion knows: the first eighteen in the order the bar shows them, then the rest by id. */
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
  abacus,
  abliteration,
  aerostack,
  aiand,
  aixy,
  alibaba,
  alibabatokenplan,
  amp,
  antigravity,
  atlascloud,
  augment,
  azureopenai,
  bedrock,
  bifrost,
  chatbox,
  chutes,
  claudeplatform,
  clawrouter,
  clinepass,
  coderabbit,
  commandcode,
  cosmic,
  cursor,
  deepgram,
  devin,
  devpass,
  doubao,
  exa,
  factory,
  fal,
  fireworks,
  flora,
  futureagi,
  gitkraken,
  grok,
  groq,
  helmcode,
  huggingface,
  hyper,
  ibmbob,
  jetbrains,
  kiro,
  langdock,
  linkup,
  litellm,
  lithosai,
  llmman,
  llmproxy,
  longcat,
  manus,
  mimo,
  mistral,
  munito,
  muse,
  museai,
  neuralwatt,
  notion,
  nous,
  openai,
  opencode,
  opencodego,
  opendesign,
  parallel,
  perplexity,
  pi,
  poe,
  qoder,
  qwencloud,
  raycast,
  replicate,
  sailresearch,
  sakana,
  siliconflow,
  sofya,
  soniox,
  stepfun,
  sub2api,
  t3chat,
  tavily,
  tinyapi,
  traecn,
  tripo,
  typesafe,
  v0,
  vercel,
  vertexai,
  wayfinder,
  windsurf,
  workbuddy,
  xai,
  xapi,
  xkiro,
  zed,
  zenmux,
  zoommate,
];
