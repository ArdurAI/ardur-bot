import type {
  Actor,
  DelegationKind,
  DelegationProblem,
  DelegationRecord,
  DelegationSnapshot,
} from "@ardurbot/contracts";
import {
  ALL_DEVICE_SCOPES,
  DELEGATION_LIMITS,
  DelegationAuthoritySchema,
  DelegationSnapshotSchema,
  delegationProblem,
  LocalityPolicySchema,
  TaskCardSchema,
} from "@ardurbot/contracts";
import {
  allowsModelDestination,
  delegationDifferences,
  effectiveRemoteAuthority,
  intersectDelegationAuthority,
  redactTaskValue,
  taskCardChecklist,
  taskCardRequest,
} from "@ardurbot/core";
import type { Delegation, Prisma, PrismaClient } from "./client.js";
import { deviceDigest } from "./device-grants.js";
import { loadRemoteAuthority } from "./dispatch.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";
import { appendTaskEvent, validateTaskReferences } from "./task-cards.js";
import { withTransactionRetry } from "./transaction-retry.js";

export class DelegationAdmissionError extends Error {
  constructor(readonly problem: DelegationProblem) {
    super(problem.message);
  }
}
const refuse = (code: DelegationProblem["code"]): never => {
  throw new DelegationAdmissionError(delegationProblem(code));
};
export const ACTIVE_DELEGATIONS = ["queued", "running", "cancel-requested"];
type Scope = Pick<Actor, "spaceId" | "userId">;

export async function lockDelegationRootForRun(tx: Prisma.TransactionClient, runId: string) {
  const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
  const rootTaskId = run.delegationRootTaskId ?? run.taskId;
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${rootTaskId} FOR UPDATE`;
  return { run: await tx.run.findUniqueOrThrow({ where: { id: runId } }), rootTaskId };
}

/** The caller creates the run in this SAME transaction. A refusal rolls everything back. */
export async function admitDelegation(
  tx: Prisma.TransactionClient,
  input: Scope & {
    comparisonId?: string;
    parentRunId: string;
    actingBotId: string;
    actingName: string;
    kind: DelegationKind;
    admissionKey: string;
    prompt: string;
    snapshot: DelegationSnapshot;
    tokens?: number;
    deadlineAt?: Date;
    newChild?: boolean;
    card?: unknown;
  },
) {
  const { run: parent, rootTaskId } = await lockDelegationRootForRun(tx, input.parentRunId);
  if (parent.spaceId !== input.spaceId || parent.userId !== input.userId)
    refuse("authority-exceeded");
  const request = taskCardRequest(input.prompt, input.card);
  const fingerprint = deviceDigest(JSON.stringify([input.actingBotId, input.kind, request]));
  const replay = await tx.delegation.findUnique({ where: { admissionKey: input.admissionKey } });
  if (replay) {
    const expected = replay.card
      ? fingerprint
      : deviceDigest(JSON.stringify([input.actingBotId, input.kind, input.prompt]));
    if (replay.fingerprint !== expected || replay.parentRunId !== parent.id)
      refuse("authority-exceeded");
    return replay;
  }
  await validateTaskReferences(tx, { spaceId: input.spaceId, userId: input.userId }, request);
  const comparison = input.comparisonId
    ? await tx.comparison.findFirstOrThrow({
        where: {
          id: input.comparisonId,
          parentRunId: parent.id,
          rootTaskId,
          spaceId: input.spaceId,
          userId: input.userId,
        },
      })
    : null;
  if (
    parent.cancelRequestedAt ||
    (parent.status !== "running" &&
      !(comparison && parent.trigger === "comparison-coordinator" && parent.status === "completed"))
  )
    refuse("deadline-passed");
  const ancestor = parent.delegationId
    ? await tx.delegation.findUniqueOrThrow({ where: { id: parent.delegationId } })
    : null;
  const requester = await tx.bot.findFirstOrThrow({
    where: { id: parent.botId, spaceId: input.spaceId, userId: input.userId },
    include: { computer: true },
  });
  const recipient = input.newChild
    ? requester
    : await tx.bot.findFirstOrThrow({
        where: {
          id: input.actingBotId,
          spaceId: input.spaceId,
          userId: input.userId,
          archivedAt: null,
        },
      });
  const space = await tx.space.findUniqueOrThrow({ where: { id: input.spaceId } });
  const now = new Date();
  const spent = await tx.usageRecord.aggregate({
    where: { rootTaskId },
    _sum: { inputTokens: true, outputTokens: true },
  });
  const root = await tx.delegationRoot.upsert({
    where: { rootTaskId },
    update: {},
    create: {
      rootTaskId,
      spaceId: input.spaceId,
      userId: input.userId,
      coordinatorBotId: parent.botId,
      coordinatorThreadId: parent.threadId,
      usedTokens: (spent._sum.inputTokens ?? 0) + (spent._sum.outputTokens ?? 0),
      deadlineAt: new Date(parent.createdAt.getTime() + DELEGATION_LIMITS.durationMs),
    },
  });
  if (root.cancelRequestedAt || root.deadlineAt <= now) refuse("deadline-passed");
  const ancestorBotIds = ancestor ? [...ancestor.ancestorBotIds, parent.botId] : [parent.botId];
  if (input.kind !== "helper" && ancestorBotIds.includes(input.actingBotId) && !comparison)
    refuse("cycle");
  const depth = (ancestor?.depth ?? 0) + 1;
  const hop = (ancestor?.hop ?? 0) + 1;
  if (depth > root.maxDepth) refuse("depth-exceeded");
  if (hop > root.maxHops) refuse("hops-exceeded");
  if (root.totalDescendants >= root.maxDescendants || root.activeDescendants >= root.maxConcurrent)
    refuse("descendants-exceeded");
  const tokens = input.tokens ?? DELEGATION_LIMITS.reservationTokens;
  if (
    !Number.isSafeInteger(tokens) ||
    tokens <= 0 ||
    root.reservedTokens + root.usedTokens + tokens > root.tokenLimit
  )
    refuse("budget-exhausted");
  const deadlineAt = new Date(
    Math.min(
      root.deadlineAt.getTime(),
      input.deadlineAt?.getTime() ??
        (request.deadlineAt ? new Date(request.deadlineAt).getTime() : Infinity),
    ),
  );
  if (!Number.isFinite(deadlineAt.getTime()) || deadlineAt <= now) refuse("deadline-passed");
  const snapshot = DelegationSnapshotSchema.parse(input.snapshot);
  for (const policy of [
    requester.allowedModelDestinations,
    recipient.allowedModelDestinations,
    space.allowedModelDestinations,
  ]) {
    const parsed = LocalityPolicySchema.safeParse(policy ?? { mode: "any" });
    if (!parsed.success || !allowsModelDestination(parsed.data, snapshot.destination))
      refuse("locality-denied");
  }
  const policies = await tx.remoteAuthorityPolicy.findMany({
    where: {
      OR: [
        { layer: "space", subjectId: input.spaceId },
        { layer: "bot", subjectId: parent.botId },
        { layer: "bot", subjectId: recipient.id },
      ],
    },
  });
  const scopes = (layer: string, subjectId: string) =>
    policies.find((p) => p.layer === layer && p.subjectId === subjectId)?.scopes ?? [
      ...ALL_DEVICE_SCOPES,
    ];
  const sharedConnections = await tx.connection.findMany({
    where: { spaceId: input.spaceId, userId: input.userId, status: "connected" },
  });
  const installs = await tx.capabilityInstall.findMany({
    where: {
      spaceId: input.spaceId,
      userId: input.userId,
      kind: { in: ["mcp", "api", "graphql"] },
    },
  });
  const sharedConnectors = [
    ...sharedConnections
      .filter((row) => row.connectorId === "pipedream")
      .map((row) => `${row.connectorId}:${row.provider}`),
    ...installs.map((row) => `installed:${row.id}`),
  ];
  const connectors = async (botId: string) =>
    (
      await tx.botMcpServer.findMany({
        where: { botId, spaceId: input.spaceId, userId: input.userId, server: { enabled: true } },
      })
    ).flatMap((row) => [
      `mcp:${row.serverId}`,
      ...(!row.needsReview && !row.allowAllTools && Array.isArray(row.allowedTools)
        ? row.allowedTools
            .filter((tool): tool is string => typeof tool === "string")
            .map((tool) => `mcp:${row.serverId}:${tool}`)
        : []),
    ]);
  const requesterConnectors = [...sharedConnectors, ...(await connectors(parent.botId))];
  const recipientConnectors = [...sharedConnectors, ...(await connectors(recipient.id))];
  const layers = [
    { scopes: scopes("bot", parent.botId), connectors: requesterConnectors },
    { scopes: scopes("bot", recipient.id), connectors: recipientConnectors },
    { scopes: scopes("space", input.spaceId), connectors: requesterConnectors },
  ];
  if (ancestor) layers.push(DelegationAuthoritySchema.parse(ancestor.authority));
  for (const id of new Set(
    [parent.originDeviceGrantId, ...parent.remoteDeviceGrantIds].filter((id): id is string =>
      Boolean(id),
    ),
  )) {
    const grant = await tx.deviceGrant.findUnique({ where: { id } });
    if (!grant || grant.userId !== parent.userId || grant.spaceId !== parent.spaceId)
      refuse("authority-exceeded");
    layers.push({
      scopes: effectiveRemoteAuthority(await loadRemoteAuthority(tx, grant!, recipient.id)),
      connectors: requesterConnectors,
    });
  }
  const authority = intersectDelegationAuthority(...layers);
  if (!authority.scopes.includes("delegate")) refuse("authority-exceeded");
  const parentSnapshot = ancestor
    ? DelegationSnapshotSchema.parse(ancestor.snapshot)
    : DelegationSnapshotSchema.parse({
        pin: parent.runtimePin,
        computer: parent.runtimeComputer ?? {
          id: requester.computerId,
          mode: requester.computer?.scope === "dedicated" ? "dedicated" : "team",
          kind: requester.computer?.kind ?? null,
        },
        destination: snapshot.destination,
      });
  if (
    (input.kind === "helper" || input.kind === "child") &&
    (JSON.stringify(snapshot.pin) !== JSON.stringify(parentSnapshot.pin) ||
      JSON.stringify(snapshot.computer) !== JSON.stringify(parentSnapshot.computer))
  )
    refuse("authority-exceeded");
  await tx.delegationRoot.update({
    where: { rootTaskId },
    data: {
      totalDescendants: { increment: 1 },
      activeDescendants: { increment: 1 },
      reservedTokens: { increment: tokens },
    },
  });
  const members = await tx.spaceMember.count({ where: { spaceId: input.spaceId } });
  const card = TaskCardSchema.parse({
    ...request,
    requesterBotId: parent.botId,
    workerBotId: input.actingBotId,
    ...(members > 1 ? { responsibleUserId: input.userId } : {}),
    approvalBoundaries: authority,
    snapshot,
    budget: { tokens, deadlineAt: deadlineAt.toISOString() },
    artifacts: [],
    timeline: [],
    reports: [],
  });
  const row = await tx.delegation.create({
    data: {
      card,
      comparisonId: comparison?.id,
      rootTaskId,
      parentRunId: parent.id,
      spaceId: input.spaceId,
      userId: input.userId,
      requesterBotId: parent.botId,
      actingBotId: input.actingBotId,
      requesterName: requester.name,
      actingName: input.actingName,
      kind: input.kind,
      depth,
      hop,
      snapshot,
      authority,
      ancestorBotIds,
      differences: delegationDifferences(parentSnapshot, snapshot, input.actingName),
      reservedTokens: tokens,
      deadlineAt,
      admissionKey: input.admissionKey,
      fingerprint,
    },
  });
  await appendTaskEvent(tx, row, "created");
  return tx.delegation.findUniqueOrThrow({ where: { id: row.id } });
}

export async function requestCancel(
  prisma: PrismaClient,
  scope: Scope,
  rootTaskId: string,
  now = new Date(),
) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${rootTaskId} FOR UPDATE`;
      const root = await tx.delegationRoot.findFirstOrThrow({ where: { rootTaskId, ...scope } });
      await tx.delegationRoot.update({
        where: { rootTaskId: root.rootTaskId },
        data: { cancelRequestedAt: now },
      });
      const stopping = await tx.delegation.findMany({
        where: { rootTaskId, status: { in: ["queued", "running"] } },
      });
      for (const row of stopping) await appendTaskEvent(tx, row, "cancel-requested");
      await tx.delegation.updateMany({
        where: { rootTaskId, status: { in: ACTIVE_DELEGATIONS } },
        data: { status: "cancel-requested", cancelRequestedAt: now },
      });
      await tx.run.updateMany({
        where: {
          ...scope,
          OR: [{ taskId: rootTaskId }, { delegationRootTaskId: rootTaskId }],
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
        },
        data: { cancelRequestedAt: now },
      });
      return { cancelRequested: true as const };
    }),
  );
}

/** Called only after the executor finishes or confirms its abort. The unique summary is durable. */
export async function finishDelegation(
  tx: Prisma.TransactionClient,
  id: string,
  status: "completed" | "failed" | "cancelled",
  text: string,
  expectedRunId?: string | null,
) {
  let row = await tx.delegation.findUniqueOrThrow({ where: { id } });
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${row.rootTaskId} FOR UPDATE`;
  row = await tx.delegation.findUniqueOrThrow({ where: { id } });
  if (expectedRunId !== undefined && row.runId !== expectedRunId) return;
  if (row.status === "cancel-requested" && status !== "cancelled") return;
  const changed = await tx.delegation.updateMany({
    where: { id, status: { in: ACTIVE_DELEGATIONS } },
    data: {
      status,
      result: redactTaskValue(text).slice(0, 2000),
      completedAt: new Date(),
      ...(status === "cancelled" ? { cancelConfirmedAt: new Date() } : {}),
    },
  });
  if (!changed.count) return;
  await appendTaskEvent(tx, row, status, text);
  await tx.delegationRoot.update({
    where: { rootTaskId: row.rootTaskId },
    data: {
      activeDescendants: { decrement: 1 },
      reservedTokens: { decrement: Math.max(0, row.reservedTokens - row.usedTokens) },
    },
  });
  const root = await tx.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: row.rootTaskId } });
  const blocks = [
    {
      kind: "text" as const,
      text: `${row.requesterName} → ${row.actingName}: ${status === "completed" ? "completed, awaiting acceptance" : status}.\n${redactTaskValue(text).slice(0, 2000)}${row.card && TaskCardSchema.parse(row.card).doneWhen.length ? `\n${taskCardChecklist(TaskCardSchema.parse(row.card))}` : ""}`,
    },
  ];
  const message = row.summaryMessageId
    ? await tx.message.update({ where: { id: row.summaryMessageId }, data: { blocks } })
    : await createThreadMessageInTransaction(tx, {
        threadId: root.coordinatorThreadId,
        botId: root.coordinatorBotId,
        role: "bot",
        blocks,
        clientNonce: `delegation-summary:${id}`,
        markUnread: false,
      });
  await tx.delegation.update({ where: { id }, data: { summaryMessageId: message.id } });
  return appendEventInTransaction(tx, {
    spaceId: row.spaceId,
    threadId: root.coordinatorThreadId,
    botId: root.coordinatorBotId,
    type: row.summaryMessageId ? "thread.message.updated" : "thread.message.created",
    payload: { messageId: message.id, role: "bot", blocks },
  });
}
export async function acceptDelegation(
  tx: Prisma.TransactionClient,
  scope: Scope,
  id: string,
  coordinatorBotId: string,
) {
  let row = await tx.delegation.findFirstOrThrow({ where: { id, ...scope } });
  const root = await tx.delegationRoot.findFirstOrThrow({
    where: { rootTaskId: row.rootTaskId, coordinatorBotId, ...scope },
  });
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${root.rootTaskId} FOR UPDATE`;
  row = await tx.delegation.findUniqueOrThrow({ where: { id } });
  const changed = await tx.delegation.updateMany({
    where: { id, status: "completed" },
    data: { status: "accepted", acceptedAt: new Date() },
  });
  if (changed.count) await appendTaskEvent(tx, row, "accepted");
  if (changed.count && row.summaryMessageId) {
    const message = await tx.message.findUniqueOrThrow({ where: { id: row.summaryMessageId } });
    const blocks = JSON.parse(JSON.stringify(message.blocks)) as Array<{
      kind: string;
      text?: string;
    }>;
    for (const block of blocks)
      if (block.text) block.text = block.text.replace("completed, awaiting acceptance", "accepted");
    await tx.message.update({ where: { id: message.id }, data: { blocks } });
    await appendEventInTransaction(tx, {
      spaceId: row.spaceId,
      threadId: root.coordinatorThreadId,
      botId: root.coordinatorBotId,
      type: "thread.message.updated",
      payload: { messageId: message.id, blocks },
    });
  }
  return { accepted: Boolean(changed.count || row.status === "accepted") };
}
export function delegationView(row: Delegation): DelegationRecord {
  return {
    ...row,
    card: row.card ? TaskCardSchema.parse(row.card) : null,
    kind: row.kind as DelegationRecord["kind"],
    status: row.status as DelegationRecord["status"],
    snapshot: DelegationSnapshotSchema.parse(row.snapshot),
    authority: DelegationAuthoritySchema.parse(row.authority),
    budget: { tokens: row.reservedTokens, deadlineAt: row.deadlineAt.toISOString() },
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
  };
}
export async function listDelegations(prisma: PrismaClient, scope: Scope, rootTaskId: string) {
  return (
    await prisma.delegation.findMany({
      where: { rootTaskId, spaceId: scope.spaceId, userId: scope.userId },
      orderBy: { createdAt: "asc" },
    })
  ).map(delegationView);
}
