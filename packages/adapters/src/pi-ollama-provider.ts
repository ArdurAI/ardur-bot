import type { AgentRunModel } from "@ardurbot/adapter-kit";
import type { MutableModels } from "@earendil-works/pi-ai";
import {
  openAiCompatibleModel,
  openAiCompatibleProvider,
} from "./pi-openai-compatible-provider.js";

/** Ollama's /v1 translates none to think=false and compatibility efforts to think=true. */
export function registerOllamaRuntime(models: MutableModels, model: AgentRunModel): MutableModels {
  if (!model.baseUrl || !model.contextWindow) return models;
  const concrete = openAiCompatibleModel(
    model.id,
    model.baseUrl,
    model.reasoning,
    model.acceptsImages,
    model.maxTokens,
    model.contextWindow,
  );
  models.setProvider(
    openAiCompatibleProvider(
      [
        {
          ...concrete,
          provider: "ollama",
          thinkingLevelMap: { off: "none", low: "medium", medium: "medium", high: "medium" },
        },
      ],
      "ollama",
    ),
  );
  return models;
}
