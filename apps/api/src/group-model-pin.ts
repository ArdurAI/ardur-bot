import { NATIVE_HOST_OWNER_MESSAGE, nativeHostOwner } from "@ardurbot/adapters";
import type { Actor, RuntimePin } from "@ardurbot/contracts";
import { RuntimePinSchema } from "@ardurbot/contracts";
import {
  appendEventInTransaction,
  createGroupRepos,
  IsolationError,
  lockOwnedGroup,
  Prisma,
  touchGroupUpdatedAt,
} from "@ardurbot/db";
import { getLogger } from "@ardurbot/logging";
import { ORPCError } from "@orpc/server";
import { validateModelPinSelection } from "./model-pin-validation.js";
import type { RouterDeps } from "./router.js";

type Target = { groupId: string; botId: string; memberId: string; expectedRevision: number };
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
        left.credentialId === right.credentialId,
    ) ||
    (left === null && right === null)
  );
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
              computer: { select: { kind: true } },
            },
          },
        },
      },
    },
  });
  if (visible?.members.length !== 1) throw new IsolationError();
  if (requested?.runtimeKind !== "pi" && requested) {
    const targetBot = visible.members[0]!.bot;
    if (!targetBot.runtimeExperimental || targetBot.computer?.kind !== "desktop")
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
      include: { bot: { select: { userId: true, spaceId: true, archivedAt: true } } },
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
    const oldPin = member.runtimePin == null ? null : RuntimePinSchema.parse(member.runtimePin);
    if (sameChoice(oldPin, choice)) return { threadId: group.thread.id, seq: null };
    if (member.modelPinRevision !== target.expectedRevision)
      throw new ORPCError("CONFLICT", {
        message: "This member's model changed. Reload the group.",
      });
    if (member.modelPinRevision >= 2_147_483_647)
      throw new ORPCError("CONFLICT", { message: "This member's model revision cannot advance." });
    const revision = member.modelPinRevision + 1;
    const nextPin = choice ? RuntimePinSchema.parse({ ...choice, revision }) : null;
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
    await deps.events.notify(committed.threadId, committed.seq).catch((error) => {
      getLogger().error("group model notification", error);
    });
  const repos = createGroupRepos(deps.prisma);
  return repos.mapGroup(await repos.getGroup(actor, target.groupId));
}
