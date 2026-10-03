import { canBotRun, modelCredentialDto, requestedBotPin } from "@ardurbot/adapters";
import type { Actor, LocalityPolicy, RuntimePin } from "@ardurbot/contracts";
import { LocalityPolicySchema, RuntimePinSchema } from "@ardurbot/contracts";
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
  const overrides = {
    groupMembers: {
      where: { group: { spaceId: actor.spaceId, archivedAt: null } },
      select: { runtimePin: true },
    },
  } as const;
  const bots = input.botId
    ? [
        await prisma.bot.findFirstOrThrow({
          where: { id: input.botId, spaceId: actor.spaceId, userId: actor.userId },
          include: overrides,
        }),
      ]
    : await prisma.bot.findMany({
        where: { spaceId: actor.spaceId, archivedAt: null },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        include: overrides,
      });
  const blocked: { id: string; name: string }[] = [];
  let reason: string | undefined;
  for (const bot of bots) {
    const pins = [
      requestedBotPin(bot),
      ...bot.groupMembers.flatMap((member) => {
        const parsed = RuntimePinSchema.safeParse(member.runtimePin);
        return parsed.success ? [parsed.data] : [];
      }),
    ];
    for (const pin of pins) {
      const scope = { spaceId: actor.spaceId, userId: bot.userId };
      const problem = await botModelDestinationProblem(
        deps,
        scope,
        pin,
        input.botId ? { botPolicy: input.policy } : { spacePolicy: input.policy },
      );
      if (!problem) continue;
      reason ??= problem.reason;
      blocked.push({ id: bot.id, name: bot.name });
      break;
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

/** Check configured destinations offline, using the model owner's connection. */
export async function botModelDestinationProblem(
  deps: Pick<RouterDeps, "prisma" | "secrets">,
  actor: Pick<Actor, "spaceId" | "userId">,
  pin: RuntimePin,
  policies: Pick<Parameters<typeof canBotRun>[0], "botPolicy" | "spacePolicy">,
) {
  const scope = actor;
  const credential =
    pin.provider && pin.credentialId
      ? await findBoundModelCredential(deps.prisma, scope, pin.provider, pin.credentialId)
      : pin.runtimeKind === "pi" && !pin.provider && !pin.modelId
        ? await findDefaultModelCredential(deps.prisma, scope)
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
  if (!pin.provider || !pin.modelId) return null;
  if ((pin.runtimeKind === "pi" || pin.runtimeKind === "hermes") && !credential) return null;
  let baseUrl: string | undefined;
  if (credential) {
    const secret = await deps.prisma.secret.findFirst({
      where: { id: credential.secretId, userId: actor.userId, spaceId: null },
    });
    if (!secret) return null;
    baseUrl = modelCredentialDto(
      credential,
      deps.secrets.load(secret.ciphertext, secret.id),
    ).baseUrl;
  }

  return canBotRun({
    pin,
    destinationModel: { provider: pin.provider!, id: pin.modelId!, baseUrl },
    ...policies,
  });
}

/** The default changes only unpinned built-in bots owned by this member. */
export async function validateDefaultModelDestinations(
  deps: Pick<RouterDeps, "prisma" | "secrets">,
  actor: Actor,
  choice: { provider: string; modelId: string | null | undefined; credentialId: string },
) {
  const bots = await deps.prisma.bot.findMany({
    where: {
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
      runtimeKind: "pi",
      modelProvider: null,
      modelId: null,
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
  if (!bots.length) return;
  const space = await deps.prisma.space.findUnique({ where: { id: actor.spaceId } });
  const blocked: { id: string; name: string }[] = [];
  let reason: string | undefined;
  for (const bot of bots) {
    const problem = await botModelDestinationProblem(
      deps,
      actor,
      {
        runtimeKind: "pi",
        provider: choice.provider,
        modelId: choice.modelId ?? null,
        credentialId: choice.credentialId,
        effort: null,
        revision: 0,
      },
      { botPolicy: bot.allowedModelDestinations, spacePolicy: space?.allowedModelDestinations },
    );
    if (!problem) continue;
    reason ??= problem.reason;
    blocked.push({ id: bot.id, name: bot.name });
  }
  if (reason)
    throw new ORPCError("BAD_REQUEST", { message: reason, data: { blockedBots: blocked } });
}
