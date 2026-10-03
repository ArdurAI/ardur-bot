import {
  effectiveHermesConfig,
  hermesConfigHash,
  NATIVE_HOST_OWNER_MESSAGE,
  nativeHostOwner,
} from "@ardurbot/adapters";
import type { Actor, RuntimePin } from "@ardurbot/contracts";
import { computerRunsOnHost, RuntimePinSchema } from "@ardurbot/contracts";
import {
  appendEventInTransaction,
  createGroupRepos,
  IsolationError,
  lockOwnedGroup,
  Prisma,
  resetBriefRetries,
  touchGroupUpdatedAt,
} from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { ORPCError } from "@orpc/server";
import { validateModelPinSelection } from "./model-pin-validation.js";
import type { RouterDeps } from "./router.js";

type Target = {
  groupId: string;
  botId: string;
  memberId: string;
  expectedRevision: number;
  expectedBotModelPinRevision?: number;
};
type Choice = Omit<RuntimePin, "revision">;

function sameChoice(left: RuntimePin | null, right: Choice | null) {
  return (
    Boolean(
      left &&
        right &&
        left.runtimeKind === right.runtimeKind &&
        left.provider === right.provider &&
        left.modelId === right.modelId &&
        left.effort === right.effort &&
        left.credentialId === right.credentialId &&
        left.runtimeConfigHash === right.runtimeConfigHash,
    ) ||
    (left === null && right === null)
  );
}

/** Store the effective Hermes settings document and its settings hash. Run admission compiles the manifest. */
export function attachHermesSettingsSnapshot<T extends { runtimeKind: string }>(
  choice: T | null,
  storedConfig: unknown,
):
  | (T & { runtimeConfig?: ReturnType<typeof effectiveHermesConfig>; runtimeConfigHash?: string })
  | null {
  if (!choice || choice.runtimeKind !== "hermes") return choice;
  const config = effectiveHermesConfig(storedConfig === Prisma.DbNull ? null : storedConfig);
  return { ...choice, runtimeConfig: config, runtimeConfigHash: hermesConfigHash(config) };
}

function auditPin(pin: RuntimePin | null) {
  return (
    pin && {
      runtimeKind: pin.runtimeKind,
      provider: pin.provider,
      modelId: pin.modelId,
      effort: pin.effort,
      credentialId: pin.credentialId,
    }
  );
}

/** Human-only owner mutation. No bot tool or paired remote route calls this service. */
export async function updateGroupMemberModelPin(
  deps: RouterDeps,
  actor: Actor,
  target: Target,
  requested: Choice | null,
) {
  const visible = await deps.prisma.chatGroup.findFirst({
    where: { id: target.groupId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
    select: {
      members: {
        where: {
          id: target.memberId,
          botId: target.botId,
          bot: {
            userId: actor.userId,
            spaceId: actor.spaceId,
            archivedAt: null,
          },
        },
        select: {
          id: true,
          bot: {
            select: {
              runtimeExperimental: true,
              computer: { select: { kind: true, connectionId: true } },
            },
          },
        },
      },
    },
  });
  if (visible?.members.length !== 1) throw new IsolationError();
  if (requested?.runtimeKind !== "pi" && requested) {
    const targetBot = visible.members[0]!.bot;
    if (!targetBot.runtimeExperimental || !computerRunsOnHost(targetBot.computer))
      throw new ORPCError("BAD_REQUEST", {
        message: "This choice needs a supported computer and bot settings.",
      });
    if (!(await nativeHostOwner(deps.prisma, actor.userId)))
      throw new ORPCError("FORBIDDEN", { message: NATIVE_HOST_OWNER_MESSAGE });
  }
  const choice = requested ? await validateModelPinSelection(deps, actor, requested) : null;
  const committed = await deps.prisma.$transaction(async (tx) => {
    await lockOwnedGroup(tx, actor, target.groupId);
    const group = await tx.chatGroup.findFirst({
      where: { id: target.groupId, userId: actor.userId, spaceId: actor.spaceId, archivedAt: null },
      select: { thread: { select: { id: true } } },
    });
    const member = await tx.chatGroupMember.findUnique({
      where: { id: target.memberId },
      include: {
        bot: {
          select: {
            userId: true,
            spaceId: true,
            archivedAt: true,
            runtimeConfig: true,
            modelPinRevision: true,
          },
        },
      },
    });
    if (
      !group?.thread ||
      !member ||
      member.groupId !== target.groupId ||
      member.botId !== target.botId ||
      member.bot.userId !== actor.userId ||
      member.bot.spaceId !== actor.spaceId ||
      member.bot.archivedAt
    )
      throw new IsolationError();
    const storedConfig: unknown = member.bot.runtimeConfig;
    const selectedChoice = attachHermesSettingsSnapshot(choice, storedConfig);
    const oldPin = member.runtimePin == null ? null : RuntimePinSchema.parse(member.runtimePin);
    const refresh =
      oldPin?.runtimeKind === "hermes" &&
      selectedChoice?.runtimeKind === "hermes" &&
      oldPin.provider === selectedChoice.provider &&
      oldPin.modelId === selectedChoice.modelId &&
      oldPin.effort === selectedChoice.effort &&
      oldPin.credentialId === selectedChoice.credentialId &&
      oldPin.runtimeConfigHash !== selectedChoice.runtimeConfigHash;
    if (refresh && target.expectedBotModelPinRevision === undefined)
      throw new ORPCError("BAD_REQUEST", {
        message: "Reload bot settings before refreshing this group.",
      });
    if (
      target.expectedBotModelPinRevision !== undefined &&
      target.expectedBotModelPinRevision !== member.bot.modelPinRevision
    )
      throw new ORPCError("CONFLICT", { message: "Bot settings changed. Reload before saving." });
    if (sameChoice(oldPin, selectedChoice)) return { threadId: group.thread.id, seq: null };
    if (member.modelPinRevision !== target.expectedRevision)
      throw new ORPCError("CONFLICT", {
        message: "This member's model changed. Reload the group.",
      });
    if (member.modelPinRevision >= 2_147_483_647)
      throw new ORPCError("CONFLICT", { message: "This member's model revision cannot advance." });
    const revision = member.modelPinRevision + 1;
    const nextPin = selectedChoice ? RuntimePinSchema.parse({ ...selectedChoice, revision }) : null;
    await tx.chatGroupMember.update({
      where: { id: member.id },
      data: { modelPinRevision: revision, runtimePin: nextPin ?? Prisma.DbNull },
    });
    await touchGroupUpdatedAt(tx, target.groupId);
    const event = await appendEventInTransaction(tx, {
      spaceId: actor.spaceId,
      threadId: group.thread.id,
      botId: target.botId,
      type: nextPin ? "group.memberModelPin.set" : "group.memberModelPin.cleared",
      payload: {
        groupId: target.groupId,
        memberId: member.id,
        botId: target.botId,
        actorId: actor.userId,
        oldRevision: member.modelPinRevision,
        newRevision: revision,
        oldPin: auditPin(oldPin),
        newPin: auditPin(nextPin),
      },
    });
    return { threadId: group.thread.id, seq: event.seq };
  });
  if (committed.seq !== null)
    await resetBriefRetries(deps.prisma, { botId: target.botId, threadId: committed.threadId });
  if (committed.seq !== null)
    await deps.events.notify(committed.threadId, committed.seq).catch((error) => {
      getLogger().error("group model notification", error);
    });
  const repos = createGroupRepos(deps.prisma);
  return repos.mapGroup(await repos.getGroup(actor, target.groupId));
}
