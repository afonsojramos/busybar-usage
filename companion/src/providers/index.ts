import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import type { Provider } from "./types.ts";

/** Every provider the companion knows, in the order the bar shows them. */
export const providers: Provider[] = [claude, codex];
