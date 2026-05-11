import { OpenAICompatBase } from "./openai-compat-base"

/**
 * Kimi (Moonshot) provider.
 * - needsReasoningRoundtrip: Kimi K2 thinking mode sends reasoning_content that
 *   must be round-tripped in assistant messages for tool calling.
 * - Temperature=1 is enforced by requiresTemperature1() in interface.ts.
 */
export class KimiProvider extends OpenAICompatBase {
  constructor() {
    super("kimi")
  }

  protected needsReasoningRoundtrip(): boolean {
    return true
  }
}
