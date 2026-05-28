import { OpenAICompatBase } from "./openai-compat-base"

export class GroqProvider extends OpenAICompatBase {
  static readonly secretKey = "GROQ_API_KEY"

  constructor() {
    super("groq")
  }
}
