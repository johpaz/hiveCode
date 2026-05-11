import { logger } from "../../utils/logger"
import { OpenAICompatBase } from "./openai-compat-base"
import type { LLMCallOptions } from "./interface"

const log = logger.child("llm-client")

/**
 * Local Llama provider.
 * - isLocalProvider: enables num_ctx, tool injection in system prompt
 * - beforeCall: auto-starts the llama server if not running
 */
export class LocalLlamaProvider extends OpenAICompatBase {
  constructor() {
    super("local-llama")
  }

  protected isLocalProvider(): boolean {
    return true
  }

  protected async beforeCall(options: LLMCallOptions): Promise<void> {
    try {
      const { llamaManager } = await import("../../gateway/llm-local/manager")
      const modelId = options.model.replace(/^local-llama\//i, "")
      await llamaManager.start("TEXT", modelId as any)
    } catch (err) {
      log.warn(`[llm-client] local-llama auto-start failed or skipped: ${err}`)
    }
  }
}
