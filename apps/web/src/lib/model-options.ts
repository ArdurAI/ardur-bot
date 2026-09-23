import type { ModelCatalogEntry } from "@ardurbot/contracts";
import { isModelUnavailableOnSubscription, recommendedModelIds } from "@ardurbot/core";

export function availableProviderModels(catalog: ModelCatalogEntry[], provider: string) {
  const preferences = Object.hasOwn(recommendedModelIds, provider)
    ? (recommendedModelIds[provider] ?? [])
    : [];
  const rank = (id: string) => {
    const index = preferences.indexOf(id);
    return index < 0 ? preferences.length : index;
  };
  return catalog
    .filter(
      (entry) =>
        entry.provider === provider &&
        !(entry.auth === "oauth" && isModelUnavailableOnSubscription(provider, entry.id)),
    )
    .sort((a, b) => rank(a.id) - rank(b.id));
}

export function unavailableSubscriptionModel(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string | null | undefined,
) {
  return Boolean(
    provider &&
      modelId &&
      catalog.some((entry) => entry.provider === provider && entry.auth === "oauth") &&
      isModelUnavailableOnSubscription(provider, modelId),
  );
}
