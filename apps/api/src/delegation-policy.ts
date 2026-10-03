import { canBotRun, modelCredentialDto, requestedBotPin } from "@ardurbot/adapters";
import type { Actor, LocalityPolicy } from "@ardurbot/contracts";
import { LocalityPolicySchema } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { findBoundModelCredential, findDefaultModelCredential } from "@ardurbot/db";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";

export async function getModelDestinations(prisma: PrismaClient, actor: Actor, botId?: string) {
  const row = botId
    ? await prisma.bot.findFirstOrThrow({
        where: { id: botId, spaceId: actor.spaceId, userId: actor.userId },
      })
    : await prisma.space.findUniqueOrThrow({ where: { id: actor.spaceId } });
  return LocalityPolicySchema.parse(row.allowedModelDestinations ?? { mode: "any" });
}
export async function setModelDestinations(
  deps: Pick<RouterDeps, "prisma" | "secrets">,
  actor: Actor,
  input: { botId?: string; policy: LocalityPolicy },
) {
  const { prisma } = deps;
  if (!input.botId) {
    const member = await prisma.spaceMember.findUnique({
      where: { spaceId_userId: { spaceId: actor.spaceId, userId: actor.userId } },
    });
    if (!member || !["owner", "admin"].includes(member.role)) throw new ORPCError("FORBIDDEN");
  }
  const bots = input.botId
    ? [
        await prisma.bot.findFirstOrThrow({
          where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
        }),
      ]
    : await prisma.bot.findMany({
        where: { spaceId: actor.spaceId, archivedAt: null },
        orderBy: [{ name: "asc" }, { id: "asc" }],
      });
  const blocked: { id: string; name: string }[] = [];
  let reason: string | undefined;
  for (const bot of bots) {
    // A space admin checks each owner's actual saved connection, not the admin's default.
    const scope = { spaceId: actor.spaceId, userId: bot.userId };
    let pin = requestedBotPin(bot);
    const credential =
      pin.provider && pin.credentialId
        ? await findBoundModelCredential(prisma, scope, pin.provider, pin.credentialId)
        : pin.runtimeKind === "pi" && !pin.provider && !pin.modelId
          ? await findDefaultModelCredential(prisma, scope)
          : null;
    if (!pin.provider && !pin.modelId && credential) {
      pin = {
        ...pin,
        provider: credential.provider,
        modelId: credential.defaultModel,
        credentialId: credential.id,
      };
    }
    // A policy cannot strand a bot that has no model connection to run with.
    if (!pin.provider || !pin.modelId) continue;
    if ((pin.runtimeKind === "pi" || pin.runtimeKind === "hermes") && !credential) continue;
    let baseUrl: string | undefined;
    if (credential) {
      const secret = await prisma.secret.findFirst({
        where: { id: credential.secretId, userId: bot.userId, spaceId: null },
      });
      if (!secret) continue;
      baseUrl = modelCredentialDto(
        credential,
        deps.secrets.load(secret.ciphertext, secret.id),
      ).baseUrl;
    }
    const problem = canBotRun({
      pin,
      destinationModel: { provider: pin.provider ?? "", id: pin.modelId ?? "", baseUrl },
      // Check only the policy being edited; relaxing a policy must not revalidate unrelated defects.
      ...(input.botId ? { botPolicy: input.policy } : { spacePolicy: input.policy }),
    });
    if (problem) {
      reason ??= problem.reason;
      blocked.push({ id: bot.id, name: bot.name });
    }
  }
  if (reason)
    throw new ORPCError("BAD_REQUEST", {
      message: reason,
      data: { blockedBots: blocked },
    });
  if (input.botId)
    await prisma.bot.update({
      where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
      data: { allowedModelDestinations: input.policy },
    });
  else
    await prisma.space.update({
      where: { id: actor.spaceId },
      data: { allowedModelDestinations: input.policy },
    });
  return { ok: true as const };
}
