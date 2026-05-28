import { OpenAICompatBase } from "./openai-compat-base"

export class CodexProvider extends OpenAICompatBase {
  /** Identificador propio en Bun.secrets: provider.codex → CODEX_API_KEY */
  static readonly secretKey = "CODEX_API_KEY"

  constructor() {
    super("codex")
  }
}
