import type { ModelCatalogEntry, ModelCredential } from "@ardurbot/contracts";
import { modelPinOptionKey } from "./model-pin-choice.js";

export function availableProviderModels(
  catalog: readonly ModelCatalogEntry[],
  provider: string,
  showAll: boolean,
): ModelCatalogEntry[] {
  return catalog.filter(
    (entry) =>
      entry.provider === provider &&
      (showAll || entry.tier !== "unsupported") &&
      (!entry.sunset || new Date(entry.sunset) > new Date()),
  );
}

export function unavailableSubscriptionModel(
  catalog: readonly ModelCatalogEntry[],
  provider: string,
  modelId: string,
): boolean {
  const entry = catalog.find((e) => e.provider === provider && e.id === modelId);
  return entry?.tier === "unsupported";
}

export function connectedModelOptions(
  catalog: readonly ModelCatalogEntry[],
  credentials: readonly ModelCredential[],
): Array<{ key: string; provider: string; modelId: string; label: string; local: boolean }> {
  const options: Array<{ key: string; provider: string; modelId: string; label: string; local: boolean }> = [];
  const seen = new Set<string>();
  
  for (const credential of credentials) {
    const providerModels = availableProviderModels(catalog, credential.provider, false).filter(
      (entry) =>
        !entry.placeholder && (!entry.credentialId || entry.credentialId === credential.id),
    );
    
    const credentialInCatalog = Boolean(
      credential.modelId &&
        catalog.some(
          (entry) =>
            entry.provider === credential.provider &&
            entry.id === credential.modelId &&
            !entry.placeholder,
        ),
    );
    
    const local = credential.provider === "ollama" || credential.provider === "local";
    
    const candidates =
      credential.provider !== "ollama" &&
      credential.modelId &&
      !credentialInCatalog &&
      !unavailableSubscriptionModel(catalog, credential.provider, credential.modelId)
        ? [
            {
              key: modelPinOptionKey(credential.provider, credential.modelId, credential.id),
              provider: credential.provider,
              modelId: credential.modelId,
              label: `${credential.label} · ${credential.modelId}`,
              local,
            },
          ]
        : providerModels.map((entry) => ({
            key: modelPinOptionKey(entry.provider, entry.id, credential.id),
            provider: entry.provider,
            modelId: entry.id,
            label: `${
              credentials.filter((item) => item.provider === credential.provider).length > 1
                ? credential.label
                : (entry.providerName ?? entry.provider)
            } · ${entry.label}`,
            local,
          }));
          
    for (const option of candidates) {
      if (seen.has(option.key)) continue;
      seen.add(option.key);
      options.push(option);
    }
  }
  
  // Hosted before Local
  return options.sort((a, b) => {
    if (a.local && !b.local) return 1;
    if (!a.local && b.local) return -1;
    return 0;
  });
}
