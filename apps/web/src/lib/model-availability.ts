import { unavailableSubscriptionModel } from "./model-options";
import type { ModelSettings } from "./use-model-settings";

export function modelUnavailable(
  { catalog, credentials }: Pick<ModelSettings, "catalog" | "credentials">,
  provider: string | null | undefined,
  modelId: string | null | undefined,
) {
  if (!provider || !modelId) return false;
  const connected = credentials.filter((entry) => entry.provider === provider && entry.hasKey);
  if (!connected.length) return true;
  if (unavailableSubscriptionModel(catalog, provider, modelId)) return true;
  return (
    !catalog.some(
      (entry) => entry.provider === provider && entry.id === modelId && !entry.placeholder,
    ) && !connected.some((entry) => entry.modelId === modelId)
  );
}

export function spaceDefaultUnavailable(settings: ModelSettings) {
  const { me, catalog, credentials } = settings;
  // A deployment or local runtime can supply the default without a personal credential.
  if (
    me.needsModel === false &&
    !credentials.some((entry) => entry.provider === me.defaultProvider)
  ) {
    return unavailableSubscriptionModel(catalog, me.defaultProvider, me.defaultModel);
  }
  return modelUnavailable(settings, me.defaultProvider, me.defaultModel);
}
