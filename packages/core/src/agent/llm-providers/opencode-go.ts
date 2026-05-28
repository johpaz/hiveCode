import { OpenAICompatBase } from "./openai-compat-base"

export class OpenCodeGoProvider extends OpenAICompatBase {
  /** Identificador propio en Bun.secrets: provider.opencode-go → OPENCODE_GO_API_KEY */
  static readonly secretKey = "OPENCODE_GO_API_KEY"

  constructor() {
    super("opencode-go")
  }
}
