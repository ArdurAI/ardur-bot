import type { RuntimePin } from "@ardurbot/contracts";
import {
  type Actor,
  applyRoomPolicyPatch,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
  type Group,
  type GroupMember,
  parseRoomPolicy,
  type RoomPolicyPatch,
  RuntimePinSchema,
  type SpaceGroup,
} from "@ardurbot/contracts";
import { parsePeerHoldRequest } from "@ardurbot/core";
import { appendBotMessageAuditInTransaction } from "./bot-comms.js";
import { lockPeerTrafficPolicy } from "./bot-comms-policy.js";
import { cancelRunsInTransaction } from "./cancel-runs.js";
import { Prisma, type PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { recordStoppedGroupAskOutcomesInTransaction } from "./group-asks.js";
import { IsolationError } from "./scope.js";
import { lockSpaceForContentCreation } from "./spaces.js";
import { activeRunSelection, activeRunStatuses, previewFromBlocks } from "./thread-listing.js";

type GroupRecord = {
  id: string;
  spaceId: string;
  userId: string;
  name: string;
  coordinatorBotId?: string | null;
  policy?: unknown;
  pinned: boolean;
  sectionId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  thread: {
    id: string;
    unread: boolean;
    messages: Array<{ blocks: unknown }>;
  } | null;
  members: Array<{
    id?: string;
    runtimePin?: unknown;
    modelPinRevision?: number;
    bot: {
      id: string;
      name: string;
      color: string;
      runs: Array<{ status: string }>;
      runtimeKind?: string;
      modelProvider?: string | null;
      modelId?: string | null;
      thinkingLevel?: string | null;
      modelCredentialId?: string | null;
      modelPinRevision?: number;
    };
  }>;
};

type SpaceGroupRecord = Pick<
  GroupRecord,
  "id" | "spaceId" | "name" | "pinned" | "sectionId" | "updatedAt" | "members"
> & {
  thread: {
    unread: boolean;
    messages: Array<{ blocks: unknown }>;
  } | null;
};

export function mapGroupMembers(members: GroupRecord["members"]): GroupMember[] {
  return members.map((member) => {
    const explicit = RuntimePinSchema.safeParse(member.runtimePin).data ?? null;
    const bot = member.bot;
    const botPin =
      bot.modelProvider && bot.modelId && bot.modelCredentialId
        ? RuntimePinSchema.parse({
            runtimeKind: bot.runtimeKind ?? "pi",
            provider: bot.modelProvider,
            modelId: bot.modelId,
            effort: bot.thinkingLevel ?? null,
            credentialId: bot.modelCredentialId,
            revision: bot.modelPinRevision ?? 0,
          })
        : null;
    return {
      botId: bot.id,
      name: bot.name,
      color: bot.color,
      status: bot.runs[0]?.status ?? "idle",
      ...(member.id
        ? {
            memberId: member.id,
            modelPinRevision: member.modelPinRevision ?? 0,
            runtimePin: explicit,
            effectiveRuntimePin: explicit ?? botPin,
            effectivePinSource: explicit
              ? ("group-member" as const)
              : botPin
                ? ("bot" as const)
                : ("space-default" as const),
          }
        : {}),
    };
  });
}

function mapGroup(group: GroupRecord): Group {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  const preview = previewFromBlocks(group.thread.messages[0]?.blocks);
  return {
    id: group.id,
    spaceId: group.spaceId,
    name: group.name,
    coordinatorBotId: group.coordinatorBotId ?? null,
    pinned: group.pinned,
    sectionId: group.sectionId,
    archivedAt: group.archivedAt?.toISOString() ?? null,
    members: mapGroupMembers(group.members),
    threadId: group.thread.id,
    preview,
    unread: group.thread.unread,
    roomPolicy: parseRoomPolicy(group.policy),
    updatedAt: group.updatedAt.toISOString(),
    createdAt: group.createdAt.toISOString(),
  };
}

function mapSpaceGroup(group: SpaceGroupRecord): SpaceGroup {
  if (!group.thread) throw new IsolationError("Group is missing its thread");
  return {
    id: group.id,
    spaceId: group.spaceId,
    name: group.name,
    pinned: group.pinned,
    sectionId: group.sectionId,
    members: mapGroupMembers(group.members),
    preview: previewFromBlocks(group.thread.messages[0]?.blocks),
    unread: group.thread.unread,
    updatedAt: group.updatedAt.toISOString(),
  };
}

function hasMinimumActiveMembers(members: readonly unknown[]) {
  return members.length >= GROUP_MEMBER_MIN;
}

async function assertOwnedBots(
  prisma: PrismaClient,
  actor: Actor,
  botIds: string[],
): Promise<GroupMember[]> {
  const unique = [...new Set(botIds)];
  if (unique.length < GROUP_MEMBER_MIN || unique.length > GROUP_MEMBER_MAX) {
    throw new IsolationError(
      `Groups require ${GROUP_MEMBER_MIN} to ${GROUP_MEMBER_MAX} distinct bots`,
    );
  }
  const bots = await prisma.bot.findMany({
    where: {
      id: { in: unique },
      spaceId: actor.spaceId,
      userId: actor.userId,
      archivedAt: null,
    },
    select: { id: true, name: true, color: true },
  });
  if (bots.length !== unique.length) throw new IsolationError();
  const botsById = new Map(bots.map((bot) => [bot.id, bot]));
  return unique.map((botId) => {
    const bot = botsById.get(botId);
    if (!bot) throw new IsolationError();
    return { botId: bot.id, name: bot.name, color: bot.color };
  });
}

const groupInclude = {
  thread: {
    include: {
      messages: { orderBy: { seq: "desc" as const }, take: 1 },
    },
  },
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          runtimeKind: true,
          modelProvider: true,
          modelId: true,
          thinkingLevel: true,
          modelCredentialId: true,
          modelPinRevision: true,
          runs: activeRunSelection,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

const groupTargetInclude = {
  thread: { select: { id: true } },
  members: {
    where: { bot: { archivedAt: null } },
    include: {
      bot: {
        select: {
          id: true,
          name: true,
          color: true,
          runtimeKind: true,
          modelProvider: true,
          modelId: true,
          thinkingLevel: true,
          modelCredentialId: true,
          modelPinRevision: true,
          runs: activeRunSelection,
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
} as const;

export function createGroupRepos(prisma: PrismaClient) {
  async function listSpaceGroupsForSpaces(actor: Actor, spaceIds: string[]): Promise<SpaceGroup[]> {
    if (spaceIds.length === 0) return [];
    const groups = await prisma.chatGroup.findMany({
      where: {
        spaceId: { in: spaceIds },
        userId: actor.userId,
        archivedAt: null,
      },
      select: {
        id: true,
        spaceId: true,
        name: true,
        pinned: true,
        sectionId: true,
        updatedAt: true,
        thread: {
          select: {
            unread: true,
            messages: {
              orderBy: { seq: "desc" },
              take: 1,
              select: { blocks: true },
            },
          },
        },
        members: groupInclude.members,
      },
      orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
    });
    return groups
      .filter((group) => hasMinimumActiveMembers(group.members))
      .map((group) => mapSpaceGroup(group));
  }

  return {
    async listGroups(actor: Actor, options: { archived?: boolean } = {}): Promise<Group[]> {
      const groups = await prisma.chatGroup.findMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: options.archived ? { not: null } : null,
        },
        include: groupInclude,
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
      });
      return groups
        .filter((group) => hasMinimumActiveMembers(group.members))
        .map((group) => mapGroup(group as GroupRecord));
    },

    listSpaceGroupsForSpaces,

    async getGroup(actor: Actor, groupId: string, options: { includeArchived?: boolean } = {}) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          ...(options.includeArchived ? {} : { archivedAt: null }),
        },
        include: groupInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return group as GroupRecord;
    },

    async getGroupTarget(actor: Actor, groupId: string) {
      const group = await prisma.chatGroup.findFirst({
        where: {
          id: groupId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          archivedAt: null,
        },
        include: groupTargetInclude,
      });
      if (!group || !hasMinimumActiveMembers(group.members)) throw new IsolationError();
      return group;
    },

    async createGroup(
      actor: Actor,
      input: { name: string; botIds: string[]; copyPinsFromGroupId?: string },
    ): Promise<Group> {
      const members = await assertOwnedBots(prisma, actor, input.botIds);
      const created = await prisma.$transaction(async (tx) => {
        await lockSpaceForContentCreation(tx, {
          spaceId: actor.spaceId,
          userId: actor.userId,
        });
        const copiedPins = new Map<string, RuntimePin>();
        if (input.copyPinsFromGroupId) {
          await lockOwnedGroup(tx, actor, input.copyPinsFromGroupId);
          const source = await tx.chatGroup.findFirst({
            where: {
              id: input.copyPinsFromGroupId,
              spaceId: actor.spaceId,
              userId: actor.userId,
              archivedAt: null,
            },
            select: {
              members: {
                where: { bot: { archivedAt: null } },
                select: { botId: true, runtimePin: true, modelPinRevision: true },
              },
            },
          });
          if (
            !source ||
            source.members.length !== members.length ||
            source.members.some((member) => !members.some((next) => next.botId === member.botId))
          )
            throw new IsolationError();
          for (const member of source.members) {
            const pin = storedMemberPin(member.runtimePin, member.modelPinRevision);
            if (!pin) continue;
            copiedPins.set(member.botId, { ...pin, revision: 1 });
          }
        }
        const group = await tx.chatGroup.create({
          data: {
            spaceId: actor.spaceId,
            userId: actor.userId,
            name: input.name.trim(),
          },
        });
        await tx.chatGroupMember.createMany({
          data: members.map((member) => ({
            groupId: group.id,
            botId: member.botId,
            ...(copiedPins.has(member.botId)
              ? { runtimePin: copiedPins.get(member.botId)!, modelPinRevision: 1 }
              : {}),
          })),
        });
        await tx.thread.create({
          data: {
            spaceId: actor.spaceId,
            groupId: group.id,
            userId: actor.userId,
          },
        });
        return tx.chatGroup.findFirstOrThrow({
          where: { id: group.id },
          include: groupInclude,
        });
      });
      return mapGroup(created as GroupRecord);
    },

    async updateGroup(
      actor: Actor,
      input: {
        groupId: string;
        coordinatorBotId?: string | null;
        name?: string;
        botIds?: string[];
        pinned?: boolean;
        sectionId?: string | null;
        roomPolicy?: RoomPolicyPatch;
      },
    ): Promise<{ group: Group; cancelledRunIds: string[] }> {
      const members = input.botIds ? await assertOwnedBots(prisma, actor, input.botIds) : undefined;
      const updated = await prisma.$transaction(async (tx) => {
        // A member change can void peer holds. Senders take the policy lock before the
        // group row, so take it first here too, or a removal and a send can deadlock.
        if (input.botIds)
          await lockPeerTrafficPolicy(tx, { spaceId: actor.spaceId, userId: actor.userId });
        await lockOwnedGroup(tx, actor, input.groupId);
        const current = await tx.chatGroup.findFirst({
          where: {
            id: input.groupId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          include: {
            members: { select: { botId: true, bot: { select: { archivedAt: true } } } },
            thread: { select: { id: true } },
          },
        });
        if (!current?.thread) throw new IsolationError();
        if (
          !members &&
          !hasMinimumActiveMembers(
            current.members.filter((member) => member.bot.archivedAt === null),
          )
        ) {
          throw new IsolationError();
        }
        const nextBotIds = new Set(
          members?.map((member) => member.botId) ?? current.members.map((member) => member.botId),
        );
        if (input.coordinatorBotId && !nextBotIds.has(input.coordinatorBotId))
          throw new IsolationError();
        const removedBotIds = current.members
          .map((member) => member.botId)
          .filter((botId) => !nextBotIds.has(botId));

        const removedRunsToCancel: {
          id: string;
          taskId: string;
          delegationId: string | null;
          threadId: string;
          spaceId: string;
        }[] = [];

        if (removedBotIds.length) {
          const removedDeliveries = await tx.botMessageDelivery.findMany({
            where: {
              spaceId: actor.spaceId,
              userId: actor.userId,
              // Goal messages record the room as their source group (same match as pausing).
              OR: [{ sourceGroupId: input.groupId }, { targetGroupId: input.groupId }],
              recipientBotId: { in: removedBotIds },
              delegationId: { not: null },
            },
            select: {
              id: true,
              delegationId: true,
              approvalEffectId: true,
              recipientBotId: true,
              spaceId: true,
              senderThreadId: true,
              senderBotId: true,
              goalId: true,
              rootTaskId: true,
              intent: true,
              hop: true,
            },
          });

          if (removedDeliveries.length) {
            const holdEffectIds = removedDeliveries.flatMap((d) =>
              d.approvalEffectId ? [d.approvalEffectId] : [],
            );
            if (holdEffectIds.length) {
              const approvedHolds = await tx.externalEffect.findMany({
                where: {
                  id: { in: holdEffectIds },
                  kind: "peer_hold",
                  status: { in: ["intended", "approved"] },
                },
                select: { id: true, request: true },
              });
              const voidable = approvedHolds
                .filter((hold) => parsePeerHoldRequest(hold.request)?.preparationOnly === false)
                .map((hold) => hold.id);
              if (voidable.length) {
                await tx.externalEffect.updateMany({
                  where: { id: { in: voidable }, status: { in: ["intended", "approved"] } },
                  data: { status: "failed", result: { reason: "peer-member-removed" } },
                });

                const voidedDeliveries = removedDeliveries.filter(
                  (d) => d.approvalEffectId && voidable.includes(d.approvalEffectId),
                );
                for (const d of voidedDeliveries) {
                  await tx.botMessageDelivery.update({
                    where: { id: d.id },
                    data: { state: "denied", outcome: "denied" },
                  });
                  await appendBotMessageAuditInTransaction(tx, d, "denied");
                }
              }
            }

            const delegationIds = removedDeliveries.flatMap((d) =>
              d.delegationId ? [d.delegationId] : [],
            );
            if (delegationIds.length) {
              const directRuns = await tx.run.findMany({
                where: {
                  delegationId: { in: delegationIds },
                  status: { in: ["queued", "peer_ready", "leased", "running"] },
                },
                select: {
                  id: true,
                  taskId: true,
                  status: true,
                  delegationId: true,
                  threadId: true,
                  spaceId: true,
                },
              });
              const parked = directRuns.filter(
                (run) => run.status === "queued" || run.status === "peer_ready",
              );
              for (const run of parked) {
                removedRunsToCancel.push(run);
              }
            }
          }
        }

        const activeRuns = removedBotIds.length
          ? await tx.run.findMany({
              where: {
                threadId: current.thread.id,
                botId: { in: removedBotIds },
                status: {
                  in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"],
                },
              },
              select: {
                id: true,
                taskId: true,
                delegationId: true,
                threadId: true,
                spaceId: true,
              },
            })
          : [];

        const allRunsToCancel = [...activeRuns, ...removedRunsToCancel];
        if (allRunsToCancel.length) {
          const now = new Date();
          await cancelRunsInTransaction(tx, allRunsToCancel, now);
          // A removed member's ask run never finalizes, so mark its round
          // stopped here or the coordination line would pulse pending forever.
          await recordStoppedGroupAskOutcomesInTransaction(tx, allRunsToCancel, now);
        }
        if (input.name !== undefined) {
          await tx.chatGroup.update({
            where: { id: input.groupId },
            data: { name: input.name.trim() },
          });
        }
        if (members) {
          if (removedBotIds.length) {
            await tx.chatGroupMember.deleteMany({
              where: { groupId: input.groupId, botId: { in: removedBotIds } },
            });
          }
          const existingBotIds = new Set(current.members.map((member) => member.botId));
          const addedBotIds = members
            .map((member) => member.botId)
            .filter((botId) => !existingBotIds.has(botId));
          if (addedBotIds.length) {
            await tx.chatGroupMember.createMany({
              data: addedBotIds.map((botId) => ({ groupId: input.groupId, botId })),
            });
          }
        }
        await tx.chatGroup.update({
          where: { id: input.groupId },
          data: {
            updatedAt: new Date(),
            coordinatorBotId:
              input.coordinatorBotId !== undefined
                ? input.coordinatorBotId
                : current.coordinatorBotId && !nextBotIds.has(current.coordinatorBotId)
                  ? null
                  : undefined,
            pinned: input.pinned,
            sectionId: input.sectionId,
            // Laid over what the room has stored, under the group lock, so a change to
            // one setting never resets another.
            ...(input.roomPolicy !== undefined
              ? { policy: applyRoomPolicyPatch(current.policy, input.roomPolicy) }
              : {}),
          },
        });
        return tx.chatGroup
          .findFirstOrThrow({
            where: { id: input.groupId },
            include: groupInclude,
          })
          .then((group) => ({ group, cancelledRunIds: activeRuns.map((run) => run.id) }));
      });
      if (!updated.group.thread) throw new IsolationError();
      return {
        group: mapGroup(updated.group as GroupRecord),
        cancelledRunIds: updated.cancelledRunIds,
      };
    },

    async archiveGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockOwnedGroup(tx, actor, groupId);
        const current = await tx.chatGroup.findFirst({
          where: {
            id: groupId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            archivedAt: null,
          },
          select: { thread: { select: { id: true } } },
        });
        if (!current?.thread) throw new IsolationError();

        const activeRuns = await tx.run.findMany({
          where: {
            threadId: current.thread.id,
            status: { in: activeRunStatuses },
          },
          select: { id: true, taskId: true, delegationId: true, threadId: true, spaceId: true },
        });
        const runIds = activeRuns.map((run) => run.id);
        const now = new Date();
        const computers = runIds.length
          ? await tx.computer.findMany({
              where: { executionRunId: { in: runIds } },
              select: {
                id: true,
                homeKey: true,
                kind: true,
                providerRef: true,
                connectionId: true,
                imageProfile: true,
                networkEgress: true,
                executionBotId: true,
                executionRunId: true,
              },
            })
          : [];
        const leases = runIds.length
          ? await tx.computerExecutionLease.findMany({
              where: { runId: { in: runIds } },
              select: { computerId: true, runId: true, fence: true },
            })
          : [];
        const leaseByComputerId = new Map(leases.map((lease) => [lease.computerId, lease]));
        const computersWithLease = computers.map((computer) => ({
          ...computer,
          executionFence: leaseByComputerId.get(computer.id)?.fence ?? 0,
        }));

        if (runIds.length) {
          await cancelRunsInTransaction(tx, activeRuns, now);
          await recordStoppedGroupAskOutcomesInTransaction(tx, activeRuns, now);
          await expireComputerExecutionLeases(tx, { runId: { in: runIds } });
          await tx.computer.updateMany({
            where: { executionRunId: { in: runIds } },
            data: {
              executionRunId: null,
              executionBotId: null,
              executionLeaseExpiresAt: null,
            },
          });
          await tx.event.deleteMany({
            where: { type: "thread.progress", runId: { in: runIds } },
          });
        }

        await tx.chatGroup.update({
          where: { id: groupId },
          data: { archivedAt: now, pinned: false },
        });

        return { cancelledRunIds: runIds, computers: computersWithLease };
      });
    },

    async restoreGroup(actor: Actor, groupId: string) {
      const restored = await prisma.chatGroup.updateMany({
        where: { id: groupId, spaceId: actor.spaceId, userId: actor.userId },
        data: { archivedAt: null },
      });
      if (restored.count !== 1) throw new IsolationError();
    },

    async removeGroup(actor: Actor, groupId: string) {
      return prisma.$transaction(async (tx) => {
        await lockOwnedGroup(tx, actor, groupId);
        const group = await tx.chatGroup.findUnique({
          where: { id: groupId },
          select: {
            artifacts: { select: { storageKey: true } },
            members: { orderBy: { createdAt: "asc" }, take: 1, select: { botId: true } },
          },
        });
        const contextBotId = group?.members[0]?.botId;
        if (!contextBotId) throw new IsolationError();
        await tx.chatGroup.delete({ where: { id: groupId } });
        return {
          contextBotId,
          artifactStorageKeys: group.artifacts.map((artifact) => artifact.storageKey),
        };
      });
    },

    mapGroup,
  };
}

export async function lockOwnedGroup(
  prisma: Pick<Prisma.TransactionClient, "$queryRaw">,
  actor: Pick<Actor, "spaceId" | "userId">,
  groupId: string,
) {
  const locked = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM chat_groups
    WHERE id = ${groupId}
      AND "spaceId" = ${actor.spaceId}
      AND "userId" = ${actor.userId}
    FOR UPDATE
  `;
  if (locked.length !== 1) throw new IsolationError();
}

export async function touchGroupUpdatedAt(
  prisma: Pick<Prisma.TransactionClient, "chatGroup">,
  groupId: string,
) {
  await prisma.chatGroup.update({
    where: { id: groupId },
    data: { updatedAt: new Date() },
  });
}

export type GroupMemberPinState = {
  memberId: string;
  botId: string;
  runtimePin: RuntimePin | null;
  modelPinRevision: number;
};

function storedMemberPin(raw: unknown, revision: number): RuntimePin | null {
  if (raw === null) return null;
  const pin = RuntimePinSchema.safeParse(raw);
  if (!pin.success || pin.data.revision !== revision) throw new IsolationError();
  return pin.data;
}

function sameChoice(left: RuntimePin, right: RuntimePin): boolean {
  return (
    left.runtimeKind === right.runtimeKind &&
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.effort === right.effort &&
    left.credentialId === right.credentialId &&
    left.runtimeConfigHash === right.runtimeConfigHash
  );
}

/** Returns explicit choices and inherited members without resolving the bot's current pin. */
export async function getGroupMemberPinStates(
  prisma: PrismaClient,
  actor: Actor,
  groupId: string,
): Promise<GroupMemberPinState[]> {
  const group = await prisma.chatGroup.findFirst({
    where: { id: groupId, spaceId: actor.spaceId, userId: actor.userId },
    select: {
      members: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, botId: true, runtimePin: true, modelPinRevision: true },
      },
    },
  });
  if (!group) throw new IsolationError();
  return group.members.map((member) => ({
    memberId: member.id,
    botId: member.botId,
    runtimePin: storedMemberPin(member.runtimePin, member.modelPinRevision),
    modelPinRevision: member.modelPinRevision,
  }));
}

export async function setGroupMemberPin(
  prisma: PrismaClient,
  actor: Actor,
  groupId: string,
  botId: string,
  choice: Omit<RuntimePin, "revision">,
): Promise<GroupMemberPinState> {
  const normalized = RuntimePinSchema.parse({ ...choice, revision: 0 });
  return prisma.$transaction(async (tx) => {
    await lockOwnedGroup(tx, actor, groupId);
    const member = await tx.chatGroupMember.findUnique({
      where: { groupId_botId: { groupId, botId } },
    });
    if (!member) throw new IsolationError();
    const current = storedMemberPin(member.runtimePin, member.modelPinRevision);
    if (current && sameChoice(current, normalized)) {
      return {
        memberId: member.id,
        botId,
        runtimePin: current,
        modelPinRevision: member.modelPinRevision,
      };
    }
    if (member.modelPinRevision >= 2_147_483_647) throw new IsolationError();
    const revision = member.modelPinRevision + 1;
    const runtimePin = { ...normalized, revision };
    await tx.chatGroupMember.update({
      where: { id: member.id },
      data: { runtimePin, modelPinRevision: revision },
    });
    return { memberId: member.id, botId, runtimePin, modelPinRevision: revision };
  });
}

export async function clearGroupMemberPin(
  prisma: PrismaClient,
  actor: Actor,
  groupId: string,
  botId: string,
): Promise<GroupMemberPinState> {
  return prisma.$transaction(async (tx) => {
    await lockOwnedGroup(tx, actor, groupId);
    const member = await tx.chatGroupMember.findUnique({
      where: { groupId_botId: { groupId, botId } },
    });
    if (!member) throw new IsolationError();
    const current = storedMemberPin(member.runtimePin, member.modelPinRevision);
    if (!current) {
      return {
        memberId: member.id,
        botId,
        runtimePin: null,
        modelPinRevision: member.modelPinRevision,
      };
    }
    if (member.modelPinRevision >= 2_147_483_647) throw new IsolationError();
    const revision = member.modelPinRevision + 1;
    await tx.chatGroupMember.update({
      where: { id: member.id },
      data: { runtimePin: Prisma.DbNull, modelPinRevision: revision },
    });
    return { memberId: member.id, botId, runtimePin: null, modelPinRevision: revision };
  });
}
