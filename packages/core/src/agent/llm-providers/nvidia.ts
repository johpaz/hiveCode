import { OpenAICompatBase } from "./openai-compat-base"

export class NvidiaProvider extends OpenAICompatBase {
  static readonly secretKey = "NVIDIA_API_KEY"

  constructor() {
    super("nvidia")
  }
}
