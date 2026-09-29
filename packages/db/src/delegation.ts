import type {
  Actor,
  DelegationKind,
  DelegationProblem,
  DelegationRecord,
  DelegationSnapshot,
  DelegationStopReason,
  MessageBlock,
} from "@ardurbot/contracts";
import {
  ALL_DEVICE_SCOPES,
  DELEGATION_LIMITS,
  DelegationAuthoritySchema,
  DelegationSnapshotSchema,
  delegationProblem,
  IntegrationManifestSchema,
  LocalityPolicySchema,
  RequestUsageObservationSchema,
  TaskCardSchema,
} from "@ardurbot/contracts";
import {
  allowsModelDestination,
  delegationDifferences,
  effectiveMcpGrantTools,
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
const PEER_RECEIPT_MAX_LENGTH = 2000;
type Scope = Pick<Actor, "spaceId" | "userId">;

async function unresolvedBrokerTokens(
  tx: Prisma.TransactionClient,
  delegationId: string,
  runId: string,
) {
  const rows = await tx.usageRecord.findMany({
    where: { delegationId, runId, observations: { some: { sequence: 0 } } },
    select: {
      inputTokens: true,
      outputTokens: true,
      categoryCoverage: true,
      observations: { orderBy: { sequence: "asc" }, select: { observation: true } },
    },
  });
  return rows.reduce((total, row) => {
    const first = RequestUsageObservationSchema.parse(row.observations[0]?.observation);
    const admission = first.admission;
    if (!admission) return total;
    const latest = RequestUsageObservationSchema.parse(row.observations.at(-1)?.observation);
    const coverage = row.categoryCoverage as { logicalInput?: string; output?: string } | null;
    if (
      latest.collection?.outcome !== undefined &&
      latest.collection.outcome !== "started" &&
      latest.collection.outcome !== "unknown" &&
      coverage?.logicalInput === "complete" &&
      coverage.output === "complete"
    )
      return total;
    return total + Math.max(0, admission.reservedTokens - row.inputTokens - row.outputTokens);
  }, 0);
}

export async function lockDelegationRootForRun(tx: Prisma.TransactionClient, runId: string) {
  const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
  const rootTaskId = run.delegationRootTaskId ?? run.taskId;
  // The first admission creates its root after locking; its parent run supplies the thread.
  await lockDelegationRootTask(tx, rootTaskId, run.threadId);
  return { run: await tx.run.findUniqueOrThrow({ where: { id: runId } }), rootTaskId };
}

/** Called under the coordinator thread/root task lock by delegation and provider admission. */
export async function ensureDelegationRootBudget(
  tx: Prisma.TransactionClient,
  input: {
    rootTaskId: string;
    spaceId: string;
    userId: string;
    coordinatorBotId: string;
    coordinatorThreadId: string;
    runCreatedAt: Date;
  },
) {
  const spent = await tx.usageRecord.aggregate({
    where: { rootTaskId: input.rootTaskId, purpose: { not: "detached-learning" } },
    _sum: { inputTokens: true, outputTokens: true },
  });
  const goal = await tx.teamGoal.findUnique({ where: { rootTaskId: input.rootTaskId } });
  return tx.delegationRoot.upsert({
    where: { rootTaskId: input.rootTaskId },
    update: {},
    create: {
      rootTaskId: input.rootTaskId,
      spaceId: input.spaceId,
      userId: input.userId,
      coordinatorBotId: goal?.coordinatorBotId ?? input.coordinatorBotId,
      coordinatorThreadId: goal?.threadId ?? input.coordinatorThreadId,
      usedTokens: (spent._sum.inputTokens ?? 0) + (spent._sum.outputTokens ?? 0),
      deadlineAt:
        goal?.untilAt ?? new Date(input.runCreatedAt.getTime() + DELEGATION_LIMITS.durationMs),
      ...(goal
        ? {
            maxDepth: goal.maxDepth,
            maxConcurrent: goal.maxConcurrent,
            maxHops: goal.maxHops,
            maxDescendants: goal.maxDescendants,
            tokenLimit: goal.tokenLimit,
          }
        : {}),
    },
  });
}

/** Canonical order: bot/group, coordinator thread, recipient thread, then root task.
 * Message submission takes bot before thread; finalization and thread clearing follow it.
 */
export async function lockDelegationRoot(tx: Prisma.TransactionClient, rootTaskId: string) {
  const root = await tx.delegationRoot.findUniqueOrThrow({
    where: { rootTaskId },
    select: { coordinatorThreadId: true },
  });
  await lockThreadThenRootTask(tx, root.coordinatorThreadId, rootTaskId);
}

/** Also covers first-turn usage before a delegation root has been created. */
export async function lockDelegationRootTask(
  tx: Prisma.TransactionClient,
  rootTaskId: string,
  fallbackThreadId: string,
) {
  const root = await tx.delegationRoot.findUnique({
    where: { rootTaskId },
    select: { coordinatorThreadId: true },
  });
  await lockThreadThenRootTask(tx, root?.coordinatorThreadId ?? fallbackThreadId, rootTaskId);
}

async function lockThreadThenRootTask(
  tx: Prisma.TransactionClient,
  threadId: string,
  rootTaskId: string,
) {
  await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${rootTaskId} FOR UPDATE`;
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
    /** One-request floor for the worker's pinned model; explicit budgets below it refuse. */
    minimumTokens?: number;
    deadlineAt?: Date;
    newChild?: boolean;
    card?: unknown;
    peerMode?: "read-only";
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
        include: { computer: true },
      });
  const space = await tx.space.findUniqueOrThrow({ where: { id: input.spaceId } });
  const now = new Date();
  const root = await ensureDelegationRootBudget(tx, {
    rootTaskId,
    spaceId: input.spaceId,
    userId: input.userId,
    coordinatorBotId: parent.botId,
    coordinatorThreadId: parent.threadId,
    runCreatedAt: parent.createdAt,
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
  // An explicit budget is never raised silently. The default reservation must still cover
  // the admission floor for this worker's model, so it grows to the floor when higher.
  const tokens =
    input.tokens ?? Math.max(DELEGATION_LIMITS.reservationTokens, input.minimumTokens ?? 0);
  if (!Number.isSafeInteger(tokens) || tokens <= 0) refuse("budget-exhausted");
  // An explicit budget the owner or coordinator set is never raised silently; one that
  // cannot cover even one request for the worker's model refuses before the worker starts.
  if (input.minimumTokens !== undefined && tokens < input.minimumTokens) refuse("budget-too-small");
  if (root.reservedTokens + root.usedTokens + tokens > root.tokenLimit) refuse("budget-exhausted");
  const deadlineAt = new Date(
    Math.min(
      root.deadlineAt.getTime(),
      input.deadlineAt?.getTime() ?? Infinity,
      request.deadlineAt ? new Date(request.deadlineAt).getTime() : Infinity,
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
  const servers = await tx.mcpServer.findMany({
    where: { spaceId: input.spaceId, userId: input.userId, enabled: true },
  });
  const connectors = async (botId: string, desktop: boolean) => {
    const rows = await tx.botMcpServer.findMany({
      where: { botId, spaceId: input.spaceId, userId: input.userId },
    });
    const overrides = new Map(rows.map((row) => [row.serverId, row]));
    return servers.flatMap((server) => {
      if (server.transport === "host-cli" && !desktop) return [];
      const row = overrides.get(server.id);
      if (
        server.needsReview ||
        row?.needsReview ||
        row?.allowAllTools ||
        row?.access === "none" ||
        (row?.access !== undefined && !["inherit", "custom"].includes(row.access))
      )
        return [];
      const manifest = IntegrationManifestSchema.safeParse(server.manifest);
      if (server.manifest && !manifest.success) return [];
      if (server.catalogId && (server.connectionState !== "connected" || !manifest.success))
        return [];
      const allowed = Array.isArray(row?.allowedTools)
        ? row.allowedTools.filter((tool): tool is string => typeof tool === "string")
        : [];
      const space = Array.isArray(server.spaceAllowedTools)
        ? server.spaceAllowedTools.filter((tool): tool is string => typeof tool === "string")
        : [];
      const offered = manifest.success ? manifest.data.tools.map((tool) => tool.id) : allowed;
      const tools = effectiveMcpGrantTools(
        offered,
        space,
        allowed,
        row?.access ?? (row ? "custom" : "inherit"),
        manifest.success,
      );
      return tools.length
        ? [`mcp:${server.id}`, ...tools.map((tool) => `mcp:${server.id}:${tool}`)]
        : [];
    });
  };
  const requesterConnectors = [
    ...sharedConnectors,
    ...(await connectors(parent.botId, requester.computer?.kind === "desktop")),
  ];
  const recipientConnectors = [
    ...sharedConnectors,
    ...(await connectors(recipient.id, recipient.computer?.kind === "desktop")),
  ];
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
    ...(input.peerMode ? { peerMode: input.peerMode } : {}),
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
    prisma.$transaction((tx) => requestCancelInTransaction(tx, scope, rootTaskId, now)),
  );
}

/** Shares the caller's transaction so a terminal goal and its cancellation commit together. */
export async function requestCancelInTransaction(
  tx: Prisma.TransactionClient,
  scope: Scope,
  rootTaskId: string,
  now = new Date(),
) {
  await lockDelegationRoot(tx, rootTaskId);
  const root = await tx.delegationRoot.findFirstOrThrow({ where: { rootTaskId, ...scope } });
  await tx.delegationRoot.update({
    where: { rootTaskId: root.rootTaskId },
    data: { cancelRequestedAt: root.cancelRequestedAt ?? now },
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
      status: {
        in: [
          "queued",
          "peer_paused",
          "peer_ready",
          "leased",
          "running",
          "waiting_input",
          "waiting_takeover",
        ],
      },
    },
    data: { cancelRequestedAt: now },
  });
  return { cancelRequested: true as const };
}

/** Same order as the execution gate: a passed deadline is terminal regardless of spend. */
export function delegationStopReason(
  row: { deadlineAt: Date; usedTokens: number; reservedTokens: number },
  now = new Date(),
): DelegationStopReason {
  if (row.deadlineAt <= now) return "deadline";
  if (row.usedTokens >= row.reservedTokens) return "budget";
  return "stopped";
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
  await lockDelegationRoot(tx, row.rootTaskId);
  row = await tx.delegation.findUniqueOrThrow({ where: { id } });
  if (expectedRunId !== undefined && row.runId !== expectedRunId) return;
  if (row.status === "cancel-requested" && status !== "cancelled") return;
  const redactedText = redactTaskValue(text);
  // A runtime that cannot be stopped mid-step still records overspend on the finished card.
  const resultText =
    status === "completed" && row.hop <= 1 && row.usedTokens > row.reservedTokens
      ? `${redactedText ? `${redactedText}\n` : ""}Overspent its token budget by ${row.usedTokens - row.reservedTokens} tokens.`
      : redactedText;
  const changed = await tx.delegation.updateMany({
    where: { id, status: { in: ACTIVE_DELEGATIONS } },
    data: {
      status,
      result: resultText.slice(0, PEER_RECEIPT_MAX_LENGTH),
      completedAt: new Date(),
      ...(status === "cancelled" ? { cancelConfirmedAt: new Date() } : {}),
    },
  });
  if (!changed.count) return;
  await appendTaskEvent(tx, row, status, text);
  const brokerHeld = row.runId ? await unresolvedBrokerTokens(tx, row.id, row.runId) : 0;
  const attemptSpent =
    row.hop > 1 && row.runId
      ? await tx.usageRecord.aggregate({
          where: {
            delegationId: row.id,
            runId: row.runId,
            purpose: { not: "detached-learning" },
          },
          _sum: { inputTokens: true, outputTokens: true },
        })
      : null;
  const usedInAttempt = attemptSpent
    ? (attemptSpent._sum.inputTokens ?? 0) + (attemptSpent._sum.outputTokens ?? 0)
    : row.usedTokens;
  const attemptLimit = row.hop > 1 ? DELEGATION_LIMITS.reservationTokens : row.reservedTokens;
  await tx.delegationRoot.update({
    where: { rootTaskId: row.rootTaskId },
    data: {
      activeDescendants: { decrement: 1 },
      reservedTokens: {
        decrement: Math.max(0, attemptLimit - usedInAttempt - brokerHeld),
      },
    },
  });
  const root = await tx.delegationRoot.findUniqueOrThrow({ where: { rootTaskId: row.rootTaskId } });
  const goalRoomAssignment =
    row.kind === "group-handoff" &&
    (await tx.teamGoal.findFirst({
      where: { rootTaskId: row.rootTaskId, threadId: root.coordinatorThreadId },
      select: { id: true },
    }));
  // Comparison delegations also use kind "message"; only message_bot keys are peer receipts.
  const peerMessageResult =
    row.kind === "message" &&
    (row.admissionKey.startsWith("bot-message:") || row.admissionKey.startsWith("message:"));
  const blocks: MessageBlock[] =
    peerMessageResult && status === "completed" && text.trim().length > 0
      ? [
          {
            kind: "bot_message_received",
            fromBotId: row.actingBotId,
            fromBotName: row.actingName,
            text: redactedText.slice(0, PEER_RECEIPT_MAX_LENGTH),
            intent: "result",
            truncated: redactedText.length > PEER_RECEIPT_MAX_LENGTH,
            fullLength: redactedText.length,
          },
        ]
      : [
          {
            kind: "text",
            text: goalRoomAssignment
              ? `${row.actingName}: ${status === "completed" ? "completed, awaiting acceptance" : status}.`
              : `${row.requesterName} → ${row.actingName}: ${status === "completed" ? "completed, awaiting acceptance" : status}.\n${resultText.slice(0, 2000)}${row.card && TaskCardSchema.parse(row.card).doneWhen.length ? `\n${taskCardChecklist(TaskCardSchema.parse(row.card))}` : ""}`,
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
  await lockDelegationRoot(tx, root.rootTaskId);
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
      if (block.kind === "text" && block.text)
        block.text = block.text.replace("completed, awaiting acceptance", "accepted");
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
