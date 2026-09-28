import type { RuntimePin, RuntimePinSource } from "@ardurbot/contracts";
import {
  RuntimePinError,
  RuntimePinSchema,
  RuntimePinSourceSchema,
  runtimePinProblem,
} from "@ardurbot/contracts";
import { lockOwnedGroup, Prisma, type PrismaClient } from "@ardurbot/db";
import type { BotPinFields } from "./pin-resolution.js";
import { hasBotPin } from "./pin-resolution.js";

type Scope = { userId: string; spaceId: string };
type Membership = { groupId: string; memberId: string; revision: number; pin: RuntimePin | null };
const unavailablePin: RuntimePin = {
  runtimeKind: "pi",
  provider: null,
  modelId: null,
  effort: null,
  credentialId: null,
  revision: 0,
};
function unavailableRoom(reason: string): never {
  throw new RuntimePinError(runtimePinProblem(unavailablePin, "pin-incomplete", reason));
}
export type RunPinCandidate = {
  snapshot: unknown;
  source: RuntimePinSource;
  usageGroupId: string | null;
  membership: Membership | null;
};

/** The persisted execution thread, never a prompt or group of origin, selects the scope. */
export async function selectRunPinSource(input: {
  prisma: PrismaClient;
  scope: Scope;
  threadId: string;
  executionGroupId?: string | null;
  botId: string;
  bot: BotPinFields;
  snapshot: unknown;
  savedSource: unknown;
  savedUsageGroupId: string | null;
  comparisonId?: string | null;
}): Promise<RunPinCandidate> {
  if (input.snapshot != null) {
    return {
      snapshot: input.snapshot,
      source:
        RuntimePinSourceSchema.safeParse(input.savedSource).data ??
        (hasBotPin(input.bot)
          ? { kind: "bot", botId: input.botId }
          : { kind: "space-default", spaceId: input.scope.spaceId, botId: input.botId }),
      usageGroupId: input.savedUsageGroupId,
      membership: null,
    };
  }
  const normalSource: RuntimePinSource = hasBotPin(input.bot)
    ? { kind: "bot", botId: input.botId }
    : { kind: "space-default", spaceId: input.scope.spaceId, botId: input.botId };
  if (input.comparisonId) {
    return { snapshot: null, source: normalSource, usageGroupId: null, membership: null };
  }
  const groupId =
    input.executionGroupId === undefined
      ? (
          await input.prisma.thread.findFirst({
            where: { id: input.threadId, spaceId: input.scope.spaceId },
            select: { groupId: true },
          })
        )?.groupId
      : input.executionGroupId;
  if (groupId === undefined) unavailableRoom("The execution thread is unavailable.");
  if (!groupId)
    return { snapshot: null, source: normalSource, usageGroupId: null, membership: null };
  const group = await input.prisma.chatGroup.findFirst({
    where: {
      id: groupId,
      thread: { id: input.threadId },
      userId: input.scope.userId,
      spaceId: input.scope.spaceId,
      archivedAt: null,
    },
    select: {
      members: {
        where: { botId: input.botId, bot: { archivedAt: null } },
        select: { id: true, modelPinRevision: true, runtimePin: true },
      },
    },
  });
  const member = group?.members[0];
  if (!member) unavailableRoom("The bot is no longer a member of this group.");
  const parsed = member.runtimePin == null ? null : RuntimePinSchema.safeParse(member.runtimePin);
  if (parsed && !parsed.success) unavailableRoom("The group model selection is incomplete.");
  const pin = parsed?.data ?? null;
  if (pin && pin.revision !== member.modelPinRevision)
    unavailableRoom("The group model selection is inconsistent.");
  return {
    snapshot: pin,
    source: pin
      ? { kind: "group-member", groupId, memberId: member.id, botId: input.botId }
      : normalSource,
    usageGroupId: groupId,
    membership: {
      groupId,
      memberId: member.id,
      revision: member.modelPinRevision,
      pin,
    },
  };
}

/** The lease fence and null pin make capture a single admission, including unavailable pins. */
export async function captureRunModelPin(input: {
  prisma: PrismaClient;
  scope: Scope;
  runId: string;
  workerId: string;
  fence: number;
  candidate: RunPinCandidate;
  pin: RuntimePin;
  destination?: { host: string | null; local: boolean };
}): Promise<
  "lost" | "stale" | { pin: RuntimePin; source: RuntimePinSource; usageGroupId: string | null }
> {
  return input.prisma.$transaction(async (tx) => {
    const membership = input.candidate.membership;
    if (membership) {
      await lockOwnedGroup(tx, input.scope, membership.groupId);
      const group = await tx.chatGroup.findFirst({
        where: { id: membership.groupId, archivedAt: null },
        select: { thread: { select: { id: true } } },
      });
      const member = await tx.chatGroupMember.findUnique({ where: { id: membership.memberId } });
      const current =
        member?.runtimePin == null ? null : RuntimePinSchema.safeParse(member.runtimePin).data;
      if (
        !group ||
        !member ||
        member.groupId !== membership.groupId ||
        member.botId !== input.candidate.source.botId ||
        member.modelPinRevision !== membership.revision ||
        JSON.stringify(current) !== JSON.stringify(membership.pin)
      )
        return "stale" as const;
      const runThread = await tx.run.findUnique({
        where: { id: input.runId },
        select: { threadId: true },
      });
      if (runThread?.threadId !== group.thread?.id) return "stale" as const;
    }
    const updated = await tx.run.updateMany({
      where: {
        id: input.runId,
        status: "running",
        leaseOwner: input.workerId,
        leaseFence: input.fence,
        runtimePin: { equals: Prisma.DbNull },
      },
      data: {
        runtimePin: input.pin,
        runtimePinSource: input.candidate.source,
        usageGroupId: input.candidate.usageGroupId,
        ...(input.destination ? { runtimeDestination: input.destination } : {}),
        modelProvider: input.pin.provider,
        modelId: input.pin.modelId,
      },
    });
    const saved = await tx.run.findUnique({
      where: { id: input.runId },
      select: {
        status: true,
        leaseOwner: true,
        leaseFence: true,
        runtimePin: true,
        runtimePinSource: true,
        usageGroupId: true,
      },
    });
    if (
      saved?.status !== "running" ||
      saved.leaseOwner !== input.workerId ||
      saved.leaseFence !== input.fence
    )
      return "lost" as const;
    if (!updated.count && saved.runtimePin == null) return "lost" as const;
    const committedPin = RuntimePinSchema.parse(saved.runtimePin);
    if (!updated.count) {
      const metadata = await tx.run.updateMany({
        where: {
          id: input.runId,
          status: "running",
          leaseOwner: input.workerId,
          leaseFence: input.fence,
        },
        data: {
          modelProvider: committedPin.provider,
          modelId: committedPin.modelId,
          ...(input.destination ? { runtimeDestination: input.destination } : {}),
        },
      });
      if (!metadata.count) return "lost" as const;
    }
    return {
      pin: committedPin,
      source:
        RuntimePinSourceSchema.safeParse(saved.runtimePinSource).data ?? input.candidate.source,
      usageGroupId: saved.usageGroupId,
    };
  });
}
