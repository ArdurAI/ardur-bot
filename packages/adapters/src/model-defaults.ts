import type { ThinkingLevel } from "@ardurbot/contracts";
import { recommendedDefaultModelId, spaceDefaultEffort } from "@ardurbot/core";
import { listPiCatalog } from "./pi-models.js";

/** Suggestions for creation/settings only. Runtime resolution requires an explicit model. */
export function defaultCatalogModelId(provider: string): string | null {
  return (
    recommendedDefaultModelId(
      provider,
      listPiCatalog()
        .filter((item) => item.provider === provider)
        .map((item) => item.id),
    ) ?? null
  );
}

export function suggestedModelEffort(levels: readonly ThinkingLevel[]): ThinkingLevel {
  return spaceDefaultEffort(undefined, levels);
}
