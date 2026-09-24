import type { RuntimePin } from "@ardurbot/contracts";
import { RuntimePinError, RuntimePinSchema, runtimePinProblem } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { findDefaultModelCredential } from "@ardurbot/db";
import { resolveModelKey } from "./executor.js";
import { resolveRunModelPin } from "./run-model-pin.js";
import type { EncryptedSecretStore } from "./secrets.js";

export async function reviewerDestination(
  prisma: PrismaClient,
  scope: { spaceId: string; userId: string },
  configured: unknown,
): Promise<RuntimePin> {
  if (configured != null) {
    const parsed = RuntimePinSchema.safeParse(configured);
    return parsed.success
      ? parsed.data
      : { provider: null, modelId: null, credentialId: null, effort: "medium", revision: 0 };
  }
  const credential = await findDefaultModelCredential(prisma, scope);
  return {
    provider: credential?.provider ?? null,
    modelId: credential?.defaultModel ?? null,
    effort: "medium",
    credentialId: credential?.id ?? null,
    revision: 0,
  };
}
export async function resolveReviewerPin(
  deps: { prisma: PrismaClient; secretStore: EncryptedSecretStore },
  scope: { spaceId: string; userId: string },
  pin: RuntimePin,
  knownSecrets: string[],
) {
  return resolveRunModelPin({
    prisma: deps.prisma,
    scope,
    bot: null,
    snapshot: pin,
    scripted: false,
    loadKey: async (credential, requested) => {
      const key = await resolveModelKey(
        deps,
        scope.userId,
        scope.spaceId,
        credential,
        requested.provider!,
        requested.modelId!,
        (values) => knownSecrets.push(...values),
        requested,
      );
      if (requested.provider !== "openai-compatible" && !key.oauth && !key.apiKey?.trim()) {
        throw new RuntimePinError(
          runtimePinProblem(
            requested,
            "pin-credential-missing",
            "The pinned connection secret is missing.",
          ),
        );
      }
      knownSecrets.push(...key.redact);
      return {
        ...key,
        provider: requested.provider!,
        id: requested.modelId!,
        apiKey: key.oauth ? undefined : key.apiKey,
        oauth: key.oauth ? { credential: key.oauth, persist: key.persistOAuth } : undefined,
      };
    },
  });
}
