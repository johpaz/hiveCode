import { logger } from "../../utils/logger"
import { OpenAICompatBase } from "./openai-compat-base"
import type { LLMCallOptions } from "./interface"

const log = logger.child("llm-client")

/**
 * Local Llama provider.
 * - isLocalProvider: enables num_ctx, tool injection in system prompt
 * Note: Hive-Code is terminal-only — local LLM server must be started manually
 */
export class LocalLlamaProvider extends OpenAICompatBase {
  constructor() {
    super("local-llama")
  }

  protected isLocalProvider(): boolean {
    return true
  }

  protected async beforeCall(options: LLMCallOptions): Promise<void> {
    // Hive-Code does not auto-start local LLM — user must start it manually
    log.debug(`[llm-client] local-llama call — ensure server is running manually`)
  }
}
