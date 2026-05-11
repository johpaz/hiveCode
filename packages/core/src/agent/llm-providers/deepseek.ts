import { OpenAICompatBase } from "./openai-compat-base"

/**
 * DeepSeek provider.
 * - needsReasoningRoundtrip: DeepSeek Reasoner sends reasoning_content that must
 *   be round-tripped in assistant messages for multi-turn tool calling.
 */
export class DeepSeekProvider extends OpenAICompatBase {
  constructor() {
    super("deepseek")
  }

  protected needsReasoningRoundtrip(): boolean {
    return true
  }
}
