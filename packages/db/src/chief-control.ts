import type {
  ChiefActionReconciliation,
  ChiefControl,
  ChiefCorrection,
  ChiefDispatch,
  ChiefStop,
} from "@ardurbot/contracts";
import {
  ChiefControlSchema,
  ChiefDispatchSchema,
  MessageBlock,
  ReconcileChiefActionInputSchema,
} from "@ardurbot/contracts";
import {
  CHIEF_RECONCILIATION_POLICY,
  chiefControlAllowsDispatch,
  chooseChiefMember,
  integrationToolKind,
  reviseChiefControl,
} from "@ardurbot/core";
import { stableJsonValue } from "@ardurbot/core/node/approval-effect-key";
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
  if (control.uncertainRunIds.length) control.uncertaintySince = now.toISOString();
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
    verificationRead?: boolean;
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
        !["write_file", "edit_file", "create_artifact", "reconcile_chief_action"].includes(
          options.tool ?? "",
        )))
  )
    return "This task must stay local. The previous destination is no longer allowed.";
  const reconciliationWrite =
    assignment.coordinator &&
    options.tool === "reconcile_chief_action" &&
    !options.remote &&
    control?.reconciliationRunId === runId &&
    assignment.plan.sourceRunId === runId;
  const verificationRead =
    options.verificationRead &&
    assignment.coordinator &&
    control?.reconciliationRunId === runId &&
    assignment.plan.sourceRunId === runId;
  if (options.tool === "reconcile_chief_action" && !reconciliationWrite)
    return "Only the current chief checking turn may reconcile the earlier action.";
  if (
    (control?.uncertainRunIds.length ||
      (control?.pendingReplan && control.reconciliationRunId === runId)) &&
    options.consequential &&
    !reconciliationWrite &&
    !verificationRead
  )
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
    verificationRead?: boolean;
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
      const control = ChiefControlSchema.safeParse(assignment.plan.control).data;
      const retained =
        control?.reconciledActions?.filter((row) => row.outcome !== "undone" && row.effectId) ?? [];
      if (input.consequential && input.effectId && retained.length) {
        const effect = await tx.externalEffect.findUnique({ where: { id: input.effectId } });
        const prior = await tx.externalEffect.findMany({
          where: {
            id: { in: retained.map((row) => row.effectId!) },
            spaceId: assignment.plan.spaceId,
          },
        });
        if (
          effect &&
          prior.some(
            (row) =>
              row.kind === effect.kind &&
              stableJsonValue(row.request) === stableJsonValue(effect.request),
          )
        )
          return { error: "The earlier action was kept or is unknown. Do not repeat it." };
      }
      const admitted = await tx.chiefActionAdmission.create({
        data: {
          runId: input.runId,
          revision: current.revision,
          attempt: input.attempt,
          executionId: input.executionId,
          consequential: input.verificationRead ? false : input.consequential,
          ...(input.tool ? { tool: input.tool } : {}),
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
  failed = false,
) {
  if (!admissionId) return;
  await prisma.chiefActionAdmission.updateMany({
    where: { id: admissionId, state: "admitted" },
    data: { state: uncertain ? "uncertain" : failed ? "failed" : "settled", settledAt: new Date() },
  });
}

function sameReconciledAction(a: ChiefActionReconciliation, b: ChiefActionReconciliation) {
  return a.runId === b.runId && a.effectId === b.effectId && a.executionId === b.executionId;
}

/** Terminal receipts resolve once; a lost executor gets unknown, never a retry grant. */
async function resolveChiefUncertainty(
  tx: Prisma.TransactionClient,
  plan: ChiefPlan,
  control: ChiefControl,
  now: Date,
) {
  const records = [...(control.reconciledActions ?? [])];
  const uncertain: string[] = [];
  const added: ChiefActionReconciliation[] = [];
  for (const runId of control.uncertainRunIds) {
    const run = await tx.run.findUnique({ where: { id: runId } });
    const leases = await tx.computerExecutionLease.count({
      where: { runId, expiresAt: { gt: now } },
    });
    const orphan =
      !leases &&
      (!run ||
        run.cancelConfirmedAt ||
        ["completed", "failed", "cancelled"].includes(run.status)) &&
      now.getTime() - new Date(control.uncertaintySince ?? plan.updatedAt).getTime() >=
        CHIEF_RECONCILIATION_POLICY.orphanOutcomeAfterMs;
    const actions = await tx.chiefActionAdmission.findMany({
      where: { runId, consequential: true },
    });
    const effects = await tx.externalEffect.findMany({ where: { runId, spaceId: plan.spaceId } });
    const inFlight = !orphan && actions.some((row) => row.state === "admitted");
    let unresolved = leases > 0 || control.stoppingRunIds.includes(runId) || inFlight;
    const entries: (ChiefActionReconciliation & { resolved: boolean })[] = [
      ...effects.map((effect) => ({
        runId,
        effectId: effect.id,
        revision: plan.revision,
        outcome:
          effect.status === "completed"
            ? ("kept" as const)
            : ["failed", "denied"].includes(effect.status)
              ? ("undone" as const)
              : ("unknown" as const),
        resolved: ["completed", "failed", "denied"].includes(effect.status),
      })),
      ...actions
        .filter((row) => !row.effectId || !effects.some((effect) => effect.id === row.effectId))
        .map((action) => ({
          runId,
          effectId: action.effectId,
          executionId: action.executionId,
          revision: plan.revision,
          outcome: "unknown" as const,
          resolved: action.state === "settled" && !action.effectId,
        })),
    ];
    if (!entries.length)
      entries.push({
        runId,
        effectId: null,
        revision: plan.revision,
        outcome: "unknown",
        resolved: Boolean(orphan),
      });
    for (const { resolved, ...entry } of entries) {
      if (records.some((row) => sameReconciledAction(row, entry))) continue;
      if ((!resolved && !orphan) || inFlight) {
        unresolved = true;
        continue;
      }
      records.push(entry);
      added.push(entry);
    }
    if (unresolved) uncertain.push(runId);
  }
  const resolvedRunIds = control.uncertainRunIds.filter((id) => !uncertain.includes(id));
  if (added.length || resolvedRunIds.length)
    await appendEventInTransaction(tx, {
      spaceId: plan.spaceId,
      threadId: plan.threadId,
      botId: plan.chiefBotId,
      type: "chief.control",
      payload: {
        requestMessageId: plan.sourceMessageId,
        revision: plan.revision,
        state: "reconciled",
        outcomes: added,
        resolvedRunIds,
      },
    });
  return {
    ...control,
    uncertainRunIds: uncertain,
    ...(records.length ? { reconciledActions: records } : {}),
  };
}

/** A plan-local verification write, not an external-effect approval or reversal. */
export async function recordChiefActionReconciliation(
  prisma: PrismaClient,
  chiefRunId: string,
  value: unknown,
) {
  const parsed = ReconcileChiefActionInputSchema.safeParse(value);
  if (!parsed.success) return { error: "Provide the earlier run, effect and its checked outcome." };
  const input = parsed.data;
  return withTransactionRetry(() =>
    prisma.$transaction(async (tx) => {
      const assignment = await tx.chiefAssignment.findUnique({
        where: { runId: chiefRunId },
        include: { plan: true },
      });
      if (!assignment)
        return { error: "Only the current chief checking turn may reconcile the earlier action." };
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${assignment.plan.threadId} FOR UPDATE`;
      const error = await chiefExecutionRefusal(tx, chiefRunId, {
        consequential: true,
        tool: "reconcile_chief_action",
      });
      if (error) return { error };
      const plan = await tx.chiefPlan.findUniqueOrThrow({ where: { id: assignment.planId } });
      const control = ChiefControlSchema.parse(plan.control);
      const record: ChiefActionReconciliation = {
        runId: input.runId,
        effectId: input.effectId,
        ...(!input.effectId && input.executionId ? { executionId: input.executionId } : {}),
        outcome: input.outcome,
        revision: plan.revision,
      };
      const prior = control.reconciledActions?.find((row) => sameReconciledAction(row, record));
      if (prior)
        return prior.outcome === input.outcome
          ? { ok: true }
          : { error: "The earlier action was already reconciled." };
      if (
        !control.uncertainRunIds.includes(input.runId) ||
        control.stoppingRunIds.includes(input.runId)
      )
        return { error: "Wait for owned teardown before checking this action." };
      const admissions = await tx.chiefActionAdmission.findMany({
        where: { runId: input.runId, consequential: true },
      });
      if (admissions.some((row) => row.state === "admitted"))
        return { error: "The earlier action is still in flight." };
      const effect = input.effectId
        ? await tx.externalEffect.findFirst({
            where: { id: input.effectId, runId: input.runId, spaceId: plan.spaceId },
          })
        : null;
      if (
        input.effectId
          ? !effect
          : !admissions.some((row) => !row.effectId && row.executionId === input.executionId)
      )
        return { error: "This effect does not belong to the earlier action." };
      if (effect?.status === "executing")
        return { error: "The earlier action is still in flight." };
      if (input.outcome !== "unknown") {
        const verification = await tx.chiefActionAdmission.findFirst({
          where: {
            runId: chiefRunId,
            ...(input.verificationExecutionId
              ? { executionId: input.verificationExecutionId }
              : {}),
            revision: plan.revision,
            consequential: false,
            state: "settled",
          },
          orderBy: { settledAt: "desc" },
        });
        if (!verification?.tool || integrationToolKind(verification.tool, "") !== "read")
          return { error: "Read back the earlier effect before recording its outcome." };
      }
      await tx.chiefPlan.update({
        where: { id: plan.id },
        data: {
          control: {
            ...control,
            reconciledActions: [...(control.reconciledActions ?? []), record],
          } as unknown as Prisma.InputJsonValue,
        },
      });
      const event = await appendEventInTransaction(tx, {
        spaceId: plan.spaceId,
        threadId: plan.threadId,
        botId: plan.chiefBotId,
        runId: chiefRunId,
        type: "chief.control",
        payload: {
          requestMessageId: plan.sourceMessageId,
          revision: plan.revision,
          state: "reconciled",
          outcomes: [record],
        },
      });
      return { ok: true, event };
    }),
  );
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
      const now = new Date();
      if (control.uncertainRunIds.length && !control.uncertaintySince)
        control = { ...control, uncertaintySince: plan.updatedAt.toISOString() };
      const stopping: string[] = [];
      for (const runId of control.stoppingRunIds) {
        const run = await tx.run.findUnique({ where: { id: runId } });
        const leases = await tx.computerExecutionLease.count({
          where: { runId, expiresAt: { gt: now } },
        });
        const unconfirmedStop = !run || (run.status === "cancelled" && !run.cancelConfirmedAt);
        if (unconfirmedStop) {
          // Polling updates plan.updatedAt; retain a fixed bound and an explicit outcome.
          control = {
            ...control,
            uncertaintySince: control.uncertaintySince ?? plan.updatedAt.toISOString(),
            uncertainRunIds: [...new Set([...control.uncertainRunIds, runId])],
          };
        }
        if (
          leases ||
          (unconfirmedStop
            ? now.getTime() - new Date(control.uncertaintySince ?? plan.updatedAt).getTime() <
              CHIEF_RECONCILIATION_POLICY.orphanOutcomeAfterMs
            : !run.cancelConfirmedAt && !["completed", "failed"].includes(run.status))
        )
          stopping.push(runId);
      }
      control = { ...control, stoppingRunIds: stopping };
      control = await resolveChiefUncertainty(tx, plan, control, now);
      await tx.chiefPlan.update({
        where: { id: planId },
        data: { control: control as unknown as Prisma.InputJsonValue },
      });
      const dispatch = ChiefDispatchSchema.safeParse(plan.dispatch).data;
      let event: Awaited<ReturnType<typeof publishChiefStopInTransaction>>;
      if (
        dispatch?.runId &&
        !stopping.includes(dispatch.runId) &&
        (dispatch.stop?.state === "requested" ||
          (!control.uncertainRunIds.length &&
            ["uncertain", "checking"].includes(dispatch.stop?.state ?? "")))
      )
        event = await publishChiefStopInTransaction(tx, plan, {
          revision: plan.revision,
          memberName: dispatch.memberName,
          state: control.uncertainRunIds.length ? "uncertain" : "confirmed",
        });
      if (!control.pendingReplan || stopping.length || control.stopped)
        return event ? { event } : undefined;
      const checking = control.uncertainRunIds.length > 0;
      if (checking && control.reconciliationRunId) return event ? { event } : undefined;
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
          clientNonce: `chief-${checking ? "reconcile" : "replan"}:${plan.id}:${plan.revision}`,
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
      control = {
        ...control,
        pendingReplan: checking,
        ...(checking ? { reconciliationRunId: run.id } : {}),
      };
      await tx.chiefPlan.update({
        where: { id: planId },
        data: {
          sourceRunId: run.id,
          decision,
          checkedFacts: facts as unknown as Prisma.InputJsonValue,
          control: control as unknown as Prisma.InputJsonValue,
        },
      });
      if (checking && dispatch)
        await publishChiefStopInTransaction(tx, plan, {
          revision: plan.revision,
          memberName: dispatch.memberName,
          state: "checking",
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
          state: checking ? "checking" : "replan",
          ownerMessageIds: owner.map((message) => message.id),
          runId: run.id,
        },
      });
      return { event: wake, runId: run.id };
    }),
  );
}

export { chiefControlAllowsDispatch };
