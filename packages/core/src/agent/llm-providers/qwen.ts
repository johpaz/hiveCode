import { OpenAICompatBase } from "./openai-compat-base"

export class QwenProvider extends OpenAICompatBase {
  static readonly secretKey = "QWEN_API_KEY"

  constructor() {
    super("qwen")
  }
}
