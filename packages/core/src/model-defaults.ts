export const recommendedModelIds: Readonly<Record<string, readonly string[]>> = {
  "openai-codex": [
    "gpt-6-astra",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
    "gpt-5.6-terra",
    "gpt-5.5",
  ],
};

export function recommendedDefaultModelId(
  provider: string,
  catalogIdsInOrder: readonly string[],
): string | undefined {
  return (
    (Object.hasOwn(recommendedModelIds, provider)
      ? recommendedModelIds[provider]?.find((id) => catalogIdsInOrder.includes(id))
      : undefined) ?? catalogIdsInOrder[0]
  );
}

export const modelIdsUnavailableOnSubscription: Readonly<Record<string, readonly string[]>> = {
  // Verified 2026-09-23 from OpenAI's error on a ChatGPT account.
  "openai-codex": ["gpt-5.3-codex-spark"],
};

export function isModelUnavailableOnSubscription(provider: string, modelId: string): boolean {
  return (
    Object.hasOwn(modelIdsUnavailableOnSubscription, provider) &&
    (modelIdsUnavailableOnSubscription[provider]?.includes(modelId) ?? false)
  );
}
