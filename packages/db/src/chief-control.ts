import type { ChiefCorrection, ChiefDispatch, ChiefStop } from "@ardurbot/contracts";
import { ChiefControlSchema, ChiefDispatchSchema, MessageBlock } from "@ardurbot/contracts";
import { chiefControlAllowsDispatch, chooseChiefMember, reviseChiefControl } from "@ardurbot/core";
import { loadChiefMemberFacts } from "./chief-loop.js";
import type { ChiefPlan, Prisma, PrismaClient } from "./client.js";
import { requestSelectiveCancelInTransaction } from "./delegation.js";
import { appendEventInTransaction } from "./events.js";
import { withTransactionRetry } from "./transaction-retry.js";

type Scope = { spaceId: string; userId: string };
export async function bindChiefAssignment(
  tx: Prisma.TransactionClient,
  input: {
    planId: string;
    runId: string;
    revision: number;
    memberId: string;
    coordinator?: boolean;
  },
) {
  return tx.chiefAssignment.upsert({
    where: { runId: input.runId },
    create: input,
    update: input.coordinator ? { ...input, supersededAt: null } : {},
  });
}

/** The caller already owns the room thread fence; never infer scope from a named bot alone. */
export async function findChiefCorrectionPlan(
  tx: Prisma.TransactionClient,
  input: Scope & {
    threadId: string;
    replyToMessageId?: string;
  },
) {
  const plans = await tx.chiefPlan.findMany({
    where: { spaceId: input.spaceId, userId: input.userId, threadId: input.threadId },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const candidates: ChiefPlan[] = [];
  for (const plan of plans) {
    const control = ChiefControlSchema.safeParse(plan.control).data;
    const assignments = await tx.chiefAssignment.findMany({ where: { planId: plan.id } });
    const active = await tx.run.count({
      where: {
        id: { in: assignments.map((row) => row.runId) },
        status: {
          in: [
            "queued",
            "leased",
            "running",
            "waiting_input",
            "waiting_takeover",
            "peer_paused",
            "peer_ready",
          ],
        },
      },
    });
    if (active || control?.pendingReplan || control?.uncertainRunIds.length) candidates.push(plan);
  }
  if (input.replyToMessageId) {
    const explicit = candidates.find(
      (plan) =>
        plan.sourceMessageId === input.replyToMessageId ||
        (plan.dispatch as { messageId?: string } | null)?.messageId === input.replyToMessageId,
    );
    if (explicit) return explicit;
    return undefined;
  }
  // A room utterance never cancels whichever unrelated task happens to be newest.
  return candidates.length === 1 ? candidates[0] : undefined;
}

export async function publishChiefStopInTransaction(
  tx: Prisma.TransactionClient,
  plan: ChiefPlan,
  stop: ChiefStop,
) {
  const dispatch = ChiefDispatchSchema.safeParse(plan.dispatch).data;
  const messageId = (plan.dispatch as { messageId?: string } | null)?.messageId;
  if (!dispatch || !messageId) return undefined;
  const message = await tx.message.findFirst({ where: { id: messageId, threadId: plan.threadId } });
  if (!message) return undefined;
  const next: ChiefDispatch = { ...dispatch, stop };
  const blocks = MessageBlock.array()
    .parse(message.blocks)
    .map((block) =>
      (block.kind === "handoff" || block.kind === "bot_message_sent") &&
      block.chiefDispatch?.requestMessageId === plan.sourceMessageId
        ? { ...block, chiefDispatch: next }
        : block,
    );
  await tx.message.update({ where: { id: message.id }, data: { blocks } });
  await tx.chiefPlan.update({
    where: { id: plan.id },
    data: {
      dispatch: { ...(plan.dispatch as Prisma.JsonObject), ...next } as Prisma.InputJsonValue,
    },
  });
  return appendEventInTransaction(tx, {
    spaceId: plan.spaceId,
    threadId: plan.threadId,
    botId: plan.chiefBotId,
    type: "thread.message.updated",
    payload: {
      messageId: message.id,
      role: message.role,
      blocks,
      messageSeq: message.seq,
      createdAt: message.createdAt.toISOString(),
    },
  });
}

export async function applyChiefCorrectionInTransaction(
  tx: Prisma.TransactionClient,
  input: Scope & {
    plan: ChiefPlan;
    correction: ChiefCorrection;
    ownerMessageId: string;
  },
) {
  const plan = await tx.chiefPlan.findFirstOrThrow({
    where: { id: input.plan.id, spaceId: input.spaceId, userId: input.userId },
  });
  const previous = ChiefControlSchema.safeParse(plan.control).data;
  if (previous?.ownerMessageIds.includes(input.ownerMessageId))
    return { runIds: previous.stoppingRunIds, eventSeq: 0 };
  const assignments = await tx.chiefAssignment.findMany({
    where: { planId: plan.id, supersededAt: null },
  });
  const affected = assignments.filter(
    (row) =>
      row.coordinator ||
      input.correction.kind !== "exclude" ||
      row.memberId === input.correction.memberId,
  );
  const affectedIds = affected.map((row) => row.runId);
  const uncertainActions = await tx.chiefActionAdmission.findMany({
    where: {
      runId: { in: affectedIds },
      consequential: true,
      state: { in: ["admitted", "uncertain"] },
    },
  });
  // Completed effects are not undone by a correction. Replacements must not repeat them.
  const effects = await tx.externalEffect.findMany({
    where: {
      runId: { in: affectedIds },
      status: { in: ["executing", "uncertain", "completed"] },
    },
    select: { runId: true },
  });
  const control = reviseChiefControl({
    previous,
    revision: plan.revision,
    ownerMessageId: input.ownerMessageId,
    correction: input.correction,
    affectedRunIds: affectedIds,
    uncertainRunIds: [
      ...uncertainActions.map((row) => row.runId),
      ...effects.map((row) => row.runId),
    ],
  });
  const now = new Date();
  await tx.chiefAssignment.updateMany({
    where: { runId: { in: affectedIds } },
    data: { supersededAt: now },
  });
  // Unaffected independent assignments keep running at the latest scope revision.
  await tx.chiefAssignment.updateMany({
    where: { planId: plan.id, supersededAt: null },
    data: { revision: control.revision },
  });
  await tx.chiefPlan.update({
    where: { id: plan.id },
    data: { revision: control.revision, control: control as unknown as Prisma.InputJsonValue },
  });
  await requestSelectiveCancelInTransaction(tx, input, affectedIds, now);
  const dispatch = ChiefDispatchSchema.safeParse(plan.dispatch).data;
  if (dispatch?.runId && affectedIds.includes(dispatch.runId))
    await publishChiefStopInTransaction(tx, plan, {
      revision: control.revision,
      memberName: dispatch.memberName,
      state: "requested",
    });
  const event = await appendEventInTransaction(tx, {
    spaceId: plan.spaceId,
    threadId: plan.threadId,
    botId: plan.chiefBotId,
    type: "chief.control",
    payload: {
      requestMessageId: plan.sourceMessageId,
      ownerMessageId: input.ownerMessageId,
      revision: control.revision,
      stoppedRunIds: affectedIds,
      state: "requested",
    },
  });
  return { runIds: affectedIds, eventSeq: event.seq };
}

/** Used by the existing execution choke point and final admission, never as authorization. */
export async function chiefExecutionRefusal(
  tx: Prisma.TransactionClient,
  runId: string,
  options: {
    consequential?: boolean;
    remote?: boolean;
    tool?: string;
  } = {},
): Promise<string | undefined> {
  const assignment = await tx.chiefAssignment.findUnique({
    where: { runId },
    include: { plan: true },
  });
  if (!assignment) return undefined;
  const control = ChiefControlSchema.safeParse(assignment.plan.control).data;
  if (assignment.plan.control !== null && !control)
    return "This attempt has not consumed the current task revision.";
  const run = await tx.run.findUnique({ where: { id: runId } });
  if (
    !run ||
    run.cancelRequestedAt ||
    assignment.supersededAt ||
    control?.stopped ||
    (!assignment.coordinator && control?.excludedIds.includes(assignment.memberId))
  )
    return "This task changed. This attempt must stand down before another action.";
  if (assignment.revision !== assignment.plan.revision)
    return "This attempt has not consumed the current task revision.";
  if (
    options.consequential &&
    (run.runtimePin as { runtimeKind?: string } | null)?.runtimeKind !== "pi"
  )
    return "This connection cannot run this peer task safely.";
  if (
    control?.localOnly &&
    (options.remote ||
      (options.consequential &&
        !["write_file", "edit_file", "create_artifact"].includes(options.tool ?? "")))
  )
    return "This task must stay local. The previous destination is no longer allowed.";
  if (control?.uncertainRunIds.length && options.consequential)
    return "The previous action may have finished. I’ll check before retrying.";
  return undefined;
}

/** Correction and final tool admission serialize on the coordinator thread. No remote I/O in this transaction. */
export async function admitChiefAction(
  prisma: PrismaClient,
  input: {
    runId: string;
    attempt: number;
    executionId: string;
    consequential: boolean;
    remote: boolean;
    tool?: string;
    effectId?: string;
  },
): Promise<{ error?: string; admissionId?: string }> {
  if (!prisma.chiefAssignment) return {};
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const assignment = await tx.chiefAssignment.findUnique({
        where: { runId: input.runId },
        include: { plan: true },
      });
      if (!assignment) return {};
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${assignment.plan.threadId} FOR UPDATE`;
      const error = await chiefExecutionRefusal(tx, input.runId, input);
      if (error) return { error };
      const run = await tx.run.findUniqueOrThrow({ where: { id: input.runId } });
      if (run.status !== "running" || run.leaseFence !== input.attempt)
        return { error: "This execution lease is no longer current." };
      const replay = await tx.chiefActionAdmission.findUnique({
        where: {
          runId_attempt_executionId: {
            runId: input.runId,
            attempt: input.attempt,
            executionId: input.executionId,
          },
        },
      });
      if (replay)
        return { error: "The previous action may have finished. I’ll check before retrying." };
      const current = await tx.chiefAssignment.findUniqueOrThrow({ where: { runId: input.runId } });
      const admitted = await tx.chiefActionAdmission.create({
        data: {
          runId: input.runId,
          revision: current.revision,
          attempt: input.attempt,
          executionId: input.executionId,
          consequential: input.consequential,
          effectId: input.effectId,
        },
      });
      return { admissionId: admitted.id };
    }),
  );
}

export async function settleChiefAction(
  prisma: PrismaClient,
  admissionId: string | undefined,
  uncertain: boolean,
) {
  if (!admissionId) return;
  await prisma.chiefActionAdmission.updateMany({
    where: { id: admissionId, state: "admitted" },
    data: { state: uncertain ? "uncertain" : "settled", settledAt: new Date() },
  });
}

/** Teardown and settlement are prerequisites, not consequences of admitting a replacement. */
export async function reconcileChiefCorrection(prisma: PrismaClient, planId: string) {
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      let plan = await tx.chiefPlan.findUnique({ where: { id: planId } });
      if (!plan) return undefined;
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${plan.threadId} FOR UPDATE`;
      plan = await tx.chiefPlan.findUniqueOrThrow({ where: { id: planId } });
      let control = ChiefControlSchema.safeParse(plan.control).data;
      if (!control) return undefined;
      const stopping: string[] = [];
      for (const runId of control.stoppingRunIds) {
        const run = await tx.run.findUnique({ where: { id: runId } });
        const leases = await tx.computerExecutionLease.count({
          where: { runId, expiresAt: { gt: new Date() } },
        });
        if (
          leases ||
          !run ||
          (!run.cancelConfirmedAt && !["completed", "failed"].includes(run.status))
        )
          stopping.push(runId);
      }
      control = { ...control, stoppingRunIds: stopping };
      await tx.chiefPlan.update({
        where: { id: planId },
        data: { control: control as unknown as Prisma.InputJsonValue },
      });
      const dispatch = ChiefDispatchSchema.safeParse(plan.dispatch).data;
      let event: Awaited<ReturnType<typeof publishChiefStopInTransaction>>;
      if (
        dispatch?.runId &&
        !stopping.includes(dispatch.runId) &&
        dispatch.stop?.state === "requested"
      )
        event = await publishChiefStopInTransaction(tx, plan, {
          revision: plan.revision,
          memberName: dispatch.memberName,
          state: control.uncertainRunIds.length ? "uncertain" : "confirmed",
        });
      if (!control.pendingReplan || stopping.length || control.stopped)
        return event ? { event } : undefined;
      // Resolve the same pin/budget/authority as the superseded chief; no generic peer steering.
      const source = await tx.run.findUniqueOrThrow({ where: { id: plan.sourceRunId } });
      const facts = await loadChiefMemberFacts(tx, plan, plan.groupId);
      const decision = control.localOnly
        ? { kind: "plan" as const }
        : chooseChiefMember({
            chiefId: plan.chiefBotId,
            operation: plan.operation as {
              taskType: "operations";
              purpose: "document-to-service" | "install-tool" | "general";
            },
            members: facts,
            excludedIds: control.excludedIds,
            requiredComputerId:
              (plan.operation as { purpose: string }).purpose === "install-tool"
                ? facts.find((member) => member.id === plan!.chiefBotId)?.computer?.id
                : undefined,
          });
      if (
        !facts.some((member) => member.id === plan!.chiefBotId && member.authorized) ||
        control.excludedIds.includes(plan.chiefBotId)
      )
        return undefined;
      const active = await tx.run.findFirst({
        where: {
          botId: source.botId,
          threadId: source.threadId,
          status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
          cancelRequestedAt: null,
        },
      });
      if (active) return event ? { event } : undefined;
      const owner = await tx.message.findMany({
        where: { id: { in: control.ownerMessageIds }, threadId: plan.threadId },
        orderBy: { seq: "asc" },
      });
      const task = await tx.task.findUniqueOrThrow({ where: { id: plan.taskId } });
      const run = await tx.run.create({
        data: {
          spaceId: plan.spaceId,
          userId: plan.userId,
          botId: plan.chiefBotId,
          threadId: plan.threadId,
          taskId: plan.taskId,
          trigger: "user",
          status: "queued",
          clientNonce: `chief-replan:${plan.id}:${plan.revision}`,
          sourceMessageId: control.ownerMessageIds.at(-1),
          goalId: source.goalId,
          delegationRootTaskId: source.delegationRootTaskId ?? plan.taskId,
          runtimePin: source.runtimePin ?? undefined,
          runtimePinSource: source.runtimePinSource ?? undefined,
          runtimeComputer: source.runtimeComputer ?? undefined,
          modelProvider: source.modelProvider,
          modelId: source.modelId,
          originDeviceGrantId: source.originDeviceGrantId,
          remoteRootTaskId: source.remoteRootTaskId,
          remoteDeviceGrantIds: source.remoteDeviceGrantIds,
        },
      });
      await tx.task.update({
        where: { id: task.id },
        data: { status: "queued", prompt: task.prompt },
      });
      await bindChiefAssignment(tx, {
        planId,
        runId: run.id,
        revision: plan.revision,
        memberId: plan.chiefBotId,
        coordinator: true,
      });
      control = { ...control, pendingReplan: false };
      await tx.chiefPlan.update({
        where: { id: planId },
        data: {
          sourceRunId: run.id,
          decision,
          checkedFacts: facts as unknown as Prisma.InputJsonValue,
          control: control as unknown as Prisma.InputJsonValue,
        },
      });
      const wake = await appendEventInTransaction(tx, {
        spaceId: plan.spaceId,
        threadId: plan.threadId,
        botId: plan.chiefBotId,
        runId: run.id,
        type: "chief.control",
        payload: {
          requestMessageId: plan.sourceMessageId,
          revision: plan.revision,
          state: "replan",
          ownerMessageIds: owner.map((message) => message.id),
          runId: run.id,
        },
      });
      return { event: wake, runId: run.id };
    }),
  );
}

export { chiefControlAllowsDispatch };
