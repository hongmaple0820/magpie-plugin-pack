// One package, sixteen providers.
//
// magpie runs every exported function as its own plugin (the qoder pattern),
// so each provider below keeps its own failure isolation, its own auth hook
// and its own concurrency limit -- they merely ship together, install
// together, and are uninstalled together.
//
// The entry may export plugin functions and nothing else: a helper exported
// from here would be executed as a plugin on load. Internals stay in
// lib/<provider>/.

export { AgnesPlugin } from "./lib/agnes/index.mjs";
export { ChatGptWebPlugin } from "./lib/chatgpt-web/index.mjs";
export { DeepSeekWebPlugin } from "./lib/deepseek-web/index.mjs";
export { DoubaoPlugin } from "./lib/doubao/index.mjs";
export { GeminiPlugin } from "./lib/gemini/index.mjs";
export { GlmPlugin } from "./lib/glm/index.mjs";
export { InkstoneAuthPlugin } from "./lib/inkstone/index.mjs";
export { KimiPlugin } from "./lib/kimi/index.mjs";
export { LobsteraiPlugin } from "./lib/lobsterai/index.mjs";
export { LoomyPlugin } from "./lib/loomy/index.mjs";
export { OpencodeFreePlugin } from "./lib/opencode-free/index.mjs";
export { PerplexityPlugin } from "./lib/perplexity/index.mjs";
export { QwenAiPlugin } from "./lib/qwen-ai/index.mjs";
export { QwenPlugin } from "./lib/qwen/index.mjs";
export { RaccoonPlugin } from "./lib/raccoon/index.mjs";
export { ZaiPlugin } from "./lib/zai/index.mjs";
