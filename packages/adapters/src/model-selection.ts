import type { AgentRunRequest } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import { usableModelId } from "@ardurbot/contracts";
import { recommendedDefaultModelId } from "@ardurbot/core";
import {
  type findDefaultModelCredential,
  findModelCredential,
  type PrismaClient,
} from "@ardurbot/db";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

type ModelCredential = Awaited<ReturnType<typeof findDefaultModelCredential>>;

export function isCatalogModelChoice(provider: string, modelId: string) {
  return [...listPiCatalog(), scriptedCatalogEntry].some(
    (item) => item.provider === provider && item.id === modelId,
  );
}

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

export async function validateConnectedModelChoice(
  prisma: PrismaClient,
  actor: Pick<Actor, "userId" | "spaceId">,
  provider: string,
  modelId: string,
) {
  const credential = await findModelCredential(prisma, actor, provider);
  if (!credential) return "Connect that model provider first";
  if (!usableModelId(modelId)) return "Unknown model for that provider";
  if (isCatalogModelChoice(provider, modelId)) return undefined;
  // Free-form saved IDs only resolve at runtime for openai-compatible connections.
  if (provider !== OPENAI_COMPATIBLE_PROVIDER_ID) {
    return "Unknown model for that provider";
  }
  const savedChoice = await prisma.spaceModelPreference.findFirst({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      modelId,
      credential: { userId: actor.userId, provider },
    },
    select: { id: true },
  });
  return savedChoice ? undefined : "Unknown model for that provider";
}

/** Select configuration without loading secrets or applying a runtime-specific fallback. */
export function selectConfiguredModel(input: {
  bot: {
    modelProvider: string | null;
    modelId: string | null;
    thinkingLevel: string | null;
  } | null;
  overrideCredential: ModelCredential;
  defaultCredential: ModelCredential;
  settings: { defaultModelProvider: string | null; defaultModelId: string | null } | null;
  deployment: { provider: string; model: string } | null;
}) {
  const { bot, overrideCredential, defaultCredential, settings, deployment } = input;
  const hasOverride = Boolean(bot?.modelProvider && usableModelId(bot.modelId));
  // A pin keeps its provider and model even if its credential disappears.
  const useOverride = hasOverride;
  const credential = useOverride ? overrideCredential : defaultCredential;
  return {
    provider:
      (useOverride ? bot!.modelProvider : null) ??
      credential?.provider ??
      settings?.defaultModelProvider ??
      deployment?.provider,
    id:
      usableModelId(useOverride ? bot!.modelId : null) ??
      usableModelId(credential?.defaultModel) ??
      (credential ? defaultCatalogModelId(credential.provider) : null) ??
      usableModelId(settings?.defaultModelId) ??
      usableModelId(deployment?.model),
    credential,
    thinkingLevel: (bot?.thinkingLevel as AgentRunRequest["model"]["thinkingLevel"]) ?? null,
  };
}
