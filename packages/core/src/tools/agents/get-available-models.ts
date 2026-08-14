/**
 * Get Available Models Tool
 *
 * Permite a los agentes consultar providers y modelos activos en la BD
 * para seleccionar el modelo óptimo al crear nuevos agentes.
 *
 * @category agents
 */

import type { Tool } from "../types.ts";
import { col } from "../../storage/hive";
import type { ModelDoc, ProviderDoc } from "../../storage/collections";

export const getAvailableModelsTool: Tool = {
  name: "get_available_models",
  description: "Obtener lista de providers y modelos activos de la base de datos. Sinónimos: ver modelos, listar providers, modelos disponibles, consultar modelos, provider activo, qué modelos tengo, modelos para código, modelos para chat",
  parameters: {
    type: "object",
    properties: {
      providerId: {
        type: "string",
        description: "Opcional: filtrar por provider (hiveagents, openai, anthropic, gemini, etc.)"
      },
      modelType: {
        type: "string",
        description: "Opcional: filtrar por tipo (llm, stt, tts, vision, embedding)"
      },
      capabilities: {
        type: "string",
        description: "Opcional: filtrar por capacidad (coding, chat, analysis, vision, reasoning)"
      }
    },
  },
  execute: async (params: Record<string, unknown>) => {
    const { providerId, modelType, capabilities } = params as {
      providerId?: string;
      modelType?: string;
      capabilities?: string;
    };

    try {
      const providers = await col<ProviderDoc>("providers");
      const models = await col<ModelDoc>("models");
      const activeProviders = new Map(
        (await providers.scan())
          .map((entry) => entry.doc)
          .filter((provider) => provider.enabled && provider.active)
          .map((provider) => [provider.id, provider])
      );

      const capNeedle = capabilities?.toLowerCase();
      const result = (await models.scan())
        .map((entry) => entry.doc)
        .filter((model) => model.enabled && model.active)
        .filter((model) => activeProviders.has(model.provider_id))
        .filter((model) => !providerId || model.provider_id === providerId)
        .filter((model) => !modelType || model.model_type === modelType)
        .filter((model) => !capNeedle || (model.capabilities ?? "").toLowerCase().includes(capNeedle))
        .sort((a, b) => {
          const pa = activeProviders.get(a.provider_id)?.name ?? a.provider_id;
          const pb = activeProviders.get(b.provider_id)?.name ?? b.provider_id;
          return pa.localeCompare(pb) || a.name.localeCompare(b.name);
        })
        .map((model) => {
          const provider = activeProviders.get(model.provider_id)!;
          return {
            providerId: provider.id,
            providerName: provider.name,
            providerCategory: provider.category,
            modelId: model.id,
            modelName: model.name,
            modelType: model.model_type,
            contextWindow: model.context_window,
            capabilities: model.capabilities ? JSON.parse(model.capabilities) : null,
          };
        });

      return {
        ok: true,
        count: result.length,
        models: result,
      };
    } catch (error) {
      return {
        ok: false,
        error: `Failed to get available models: ${(error as Error).message}`,
      };
    }
  },
};
