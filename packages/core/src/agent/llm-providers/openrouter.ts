import { OpenAICompatBase } from "./openai-compat-base"

export class OpenRouterProvider extends OpenAICompatBase {
  static readonly secretKey = "OPENROUTER_API_KEY"

  constructor() {
    super("openrouter")
  }
}
