import type { Actor } from "@ardurbot/contracts";
import { usableModelId } from "@ardurbot/contracts";
import { findModelCredential, type PrismaClient } from "@ardurbot/db";
import { listPiCatalog, scriptedCatalogEntry } from "./pi-models.js";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "./pi-openai-compatible-provider.js";

export function isCatalogModelChoice(provider: string, modelId: string) {
  return [...listPiCatalog(), scriptedCatalogEntry].some(
    (item) => item.provider === provider && item.id === modelId,
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

export { defaultCatalogModelId } from "./model-defaults.js";
export { selectConfiguredModel } from "./pin-resolution.js";
