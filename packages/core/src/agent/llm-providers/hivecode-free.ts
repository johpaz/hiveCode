import { OpenAICompatBase } from "./openai-compat-base"

export class HivecodeFreeProvider extends OpenAICompatBase {
  constructor() {
    super("hivecode-free")
  }

  /**
   * No key is required from the client — `apiKey` (the personal
   * `hivecode_token`) is injected by `resolveProviderConfig()` from
   * `Bun.secrets` after the user runs `/auth`. If it's missing, the base
   * class throws a clear error prompting the user to authenticate.
   */
}
