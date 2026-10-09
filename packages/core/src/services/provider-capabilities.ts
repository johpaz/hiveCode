import { GeminiProvider } from "../agent/llm-providers/gemini"
import { AnthropicProvider } from "../agent/llm-providers/anthropic"
import { OpenAIProvider } from "../agent/llm-providers/openai"
import { GroqProvider } from "../agent/llm-providers/groq"
import { MistralProvider } from "../agent/llm-providers/mistral"
import { OpenRouterProvider } from "../agent/llm-providers/openrouter"
import { DeepSeekProvider } from "../agent/llm-providers/deepseek"
import { KimiProvider } from "../agent/llm-providers/kimi"
import { NvidiaProvider } from "../agent/llm-providers/nvidia"
import { QwenProvider } from "../agent/llm-providers/qwen"
import { CodexProvider } from "../agent/llm-providers/codex"
import { OpenCodeGoProvider } from "../agent/llm-providers/opencode-go"
import { MiniMaxProvider } from "../agent/llm-providers/minimax"
import { HivecodeFreeProvider } from "../agent/llm-providers/hivecode-free"
import { HiveAgentsProvider } from "../agent/llm-providers/hiveagents"
import type { LLMProvider } from "../agent/llm-providers/interface";

/** Runtime adapters, separate from mutable provider and model records. */
const adapters: Readonly<Record<string, () => LLMProvider>> = {
  "gemini": () => new GeminiProvider(),
  "anthropic": () => new AnthropicProvider(),
  "openai": () => new OpenAIProvider(),
  "groq": () => new GroqProvider(),
  "mistral": () => new MistralProvider(),
  "openrouter": () => new OpenRouterProvider(),
  "deepseek": () => new DeepSeekProvider(),
  "kimi": () => new KimiProvider(),
  "nvidia": () => new NvidiaProvider(),
  "qwen": () => new QwenProvider(),
  "codex": () => new CodexProvider(),
  "opencode-go": () => new OpenCodeGoProvider(),
  "minimax": () => new MiniMaxProvider(),
  "hivecode-free": () => new HivecodeFreeProvider(),
  "hiveagents": () => new HiveAgentsProvider(),
};
export const SUPPORTED_LLM_PROVIDERS: ReadonlySet<string> = new Set(Object.keys(adapters));
export function createProviderAdapter(provider: string): LLMProvider {
  const id = provider === "google" ? "gemini" : provider;
  return (adapters[id] ?? adapters.openai!)();
}
export function providerCredentialName(provider: string): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}
