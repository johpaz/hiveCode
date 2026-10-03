import { OpenAICompatBase } from "./openai-compat-base"

export class NvidiaProvider extends OpenAICompatBase {
  static readonly secretKey = "NVIDIA_API_KEY"

  constructor() {
    super("nvidia")
  }

  /**
   * En NVIDIA "nvidia/" no es un prefijo de catálogo sino la organización de sus
   * propios modelos (nvidia/nemotron-3-super-120b-a12b). Quitarlo, como hace la base
   * con el prefijo del provider, manda un id que NVIDIA no conoce: 404 "page not
   * found" en toda la familia Nemotron (verificado 2026-09-10). Los ids del catálogo
   * de NVIDIA ya son los que viajan.
   */
  protected requestModelId(model: string): string {
    return model
  }
}
