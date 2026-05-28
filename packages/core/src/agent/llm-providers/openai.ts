import { OpenAICompatBase } from "./openai-compat-base"

export class OpenAIProvider extends OpenAICompatBase {
  static readonly secretKey = "OPENAI_API_KEY"

  constructor() {
    super("openai")
  }
}
