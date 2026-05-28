import { OpenAICompatBase } from "./openai-compat-base"

export class MistralProvider extends OpenAICompatBase {
  static readonly secretKey = "MISTRAL_API_KEY"

  constructor() {
    super("mistral")
  }
}
