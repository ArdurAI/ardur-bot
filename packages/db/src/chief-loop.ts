import type {
  ChiefDecision,
  ChiefDispatch,
  ChiefMemberFacts,
  ChiefOperation,
  ChiefReceipt,
  ChiefReceiptKey,
} from "@ardurbot/contracts";
import { IntegrationManifestSchema, MessageBlock, RuntimePinSchema } from "@ardurbot/contracts";
import {
  CHIEF_POLICY_VERSION,
  CHIEF_RECEIPT_TEMPLATES,
  chooseChiefMember,
  effectiveMcpGrantTools,
  integrationToolKind,
} from "@ardurbot/core";
import type { Prisma, PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";
import { createThreadMessageInTransaction } from "./messages.js";

export {
  projectChiefActivity,
  publishChiefDraftResult,
  settleChiefActivity,
} from "./chief-activity.js";

type Scope = { spaceId: string; userId: string };
/** No probes, private task prompts, connection values or credentials in this projection. */
export async function loadChiefMemberFacts(
  tx: Prisma.TransactionClient,
  { spaceId, userId }: Scope,
  groupId: string,
  now = new Date(),
): Promise<ChiefMemberFacts[]> {
  const scope = { spaceId, userId };
  const bots = await tx.bot.findMany({
    where: {
      ...scope,
      archivedAt: null,
      groupMembers: { some: { groupId, group: { ...scope, archivedAt: null } } },
    },
    select: {
      id: true,
      name: true,
      title: true,
      runtimeKind: true,
      modelId: true,
      thinkingLevel: true,
      modelPinRevision: true,
      concurrentRuns: true,
      space: { select: { concurrentRuns: true } },
      computer: {
        select: {
          id: true,
          kind: true,
          state: true,
          connectionId: true,
          controlHolder: true,
          controlLeaseExpiresAt: true,
        },
      },
      taughtSkills: {
        where: { ...scope, status: "saved", enabled: true },
        select: { id: true, name: true, goal: true },
      },
      groupMembers: {
        where: { groupId },
        select: { createdAt: true, runtimePin: true, modelPinRevision: true },
      },
    },
    orderBy: { id: "asc" },
  });
  const ids = bots.map((bot) => bot.id);
  const [runs, servers, leases, maintenance] = await Promise.all([
    tx.run.findMany({
      where: {
        ...scope,
        botId: { in: ids },
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      select: { botId: true, status: true },
    }),
    tx.mcpServer.findMany({
      where: { ...scope, enabled: true, catalogId: "notion" },
      select: {
        manifest: true,
        connectionState: true,
        lastCheckedAt: true,
        needsReview: true,
        spaceAllowedTools: true,
        assignments: {
          where: { ...scope, botId: { in: ids } },
          select: { botId: true, access: true, allowedTools: true, needsReview: true },
        },
      },
    }),
    tx.computerExecutionLease.findMany({
      where: {
        computerId: { in: bots.flatMap((bot) => bot.computer?.id ?? []) },
        expiresAt: { gt: now },
      },
      select: { computerId: true },
    }),
    tx.botBrief.findMany({
      where: { ...scope, botId: { in: ids }, leaseExpiresAt: { gt: now } },
      select: { botId: true },
    }),
  ]);
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return bots.map((bot) => {
    const groupPin = RuntimePinSchema.safeParse(bot.groupMembers[0]?.runtimePin).data;
    const runtimeKind = groupPin?.runtimeKind ?? bot.runtimeKind;
    const capabilities: ChiefMemberFacts["capabilities"][number][] = [];
    for (const server of servers) {
      const assignment = server.assignments.find((row) => row.botId === bot.id);
      const manifest = IntegrationManifestSchema.safeParse(server.manifest);
      const granted =
        manifest.success && !server.needsReview && !assignment?.needsReview
          ? effectiveMcpGrantTools(
              manifest.data.tools.map((tool) => tool.id),
              strings(server.spaceAllowedTools),
              strings(assignment?.allowedTools),
              assignment?.access ?? "inherit",
              true,
            )
          : [];
      const readBack =
        manifest.success &&
        manifest.data.tools.some(
          (tool) =>
            granted.includes(tool.id) &&
            integrationToolKind(tool.id, tool.description) === "read" &&
            /fetch|get|retrieve|read/i.test(tool.id),
        );
      capabilities.push({
        id: "notion:read-back",
        access:
          server.connectionState === "connected" && readBack
            ? "known"
            : server.connectionState === "needs-sign-in"
              ? "missing"
              : "unknown",
        checkedAt: (server.lastCheckedAt ?? now).toISOString(),
      });
    }
    const local = Boolean(
      bot.computer &&
        !bot.computer.connectionId &&
        ["docker", "podman", "desktop"].includes(bot.computer.kind),
    );
    // Preparation only: execution still needs the existing exact installation approval.
    if (local && runtimeKind === "pi" && bot.computer?.kind !== "desktop")
      capabilities.push({
        id: "computer:package-preparation",
        access: "known",
        checkedAt: now.toISOString(),
      });
    return {
      id: bot.id,
      name: bot.name,
      role: bot.title,
      skills: bot.taughtSkills.map((skill) => ({
        id: skill.id,
        descriptor: `${skill.name} ${skill.goal}`,
      })),
      capabilities,
      authorized: true,
      runtimeSupported: runtimeKind === "pi",
      pin: {
        runtime: runtimeKind,
        model: groupPin?.modelId ?? bot.modelId,
        effort: groupPin?.effort ?? bot.thinkingLevel,
        revision: groupPin?.revision ?? bot.modelPinRevision,
      },
      computer: bot.computer
        ? {
            id: bot.computer.id,
            kind: bot.computer.kind,
            state: bot.computer.state,
            local,
            leaseBusy:
              leases.some((lease) => lease.computerId === bot.computer?.id) ||
              Boolean(
                bot.computer.controlHolder !== "none" &&
                  bot.computer.controlLeaseExpiresAt &&
                  bot.computer.controlLeaseExpiresAt > now,
              ),
          }
        : null,
      inputAccess: local ? "known" : "unknown",
      activeRuns:
        runs.filter((run) => run.botId === bot.id && run.status !== "queued").length +
        maintenance.filter((row) => row.botId === bot.id).length,
      queuedRuns: runs.filter((run) => run.botId === bot.id && run.status === "queued").length,
      runLimit: bot.concurrentRuns ?? bot.space.concurrentRuns,
      membershipRevision: `${bot.groupMembers[0]?.createdAt.toISOString() ?? ""}:${bot.groupMembers[0]?.modelPinRevision ?? 0}`,
    };
  });
}

export async function createChiefReceipt(
  tx: Prisma.TransactionClient,
  input: Scope & {
    threadId: string;
    chiefBotId: string;
    requestMessageId: string;
    key: ChiefReceiptKey;
  },
): Promise<{ receipt: ChiefReceipt; eventSeq: number }> {
  const block = {
    kind: "chief_receipt" as const,
    requestMessageId: input.requestMessageId,
    key: input.key,
    text: CHIEF_RECEIPT_TEMPLATES[input.key],
  };
  const message = await createThreadMessageInTransaction(tx, {
    threadId: input.threadId,
    role: "bot",
    botId: input.chiefBotId,
    origin: "system",
    blocks: [block],
    clientNonce: `chief-receipt:${input.requestMessageId}`,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: input.spaceId,
    threadId: input.threadId,
    botId: input.chiefBotId,
    type: "thread.message.created",
    payload: { messageId: message.id, role: "bot", origin: "system", blocks: [block] },
  });
  return {
    receipt: {
      id: message.id,
      threadId: message.threadId,
      seq: message.seq,
      botId: input.chiefBotId,
      requestMessageId: input.requestMessageId,
      key: input.key,
      text: block.text,
      createdAt: message.createdAt.toISOString(),
    },
    eventSeq: event.seq,
  };
}
export async function readChiefReceipt(
  prisma: PrismaClient,
  threadId: string,
  requestMessageId: string,
): Promise<ChiefReceipt | undefined> {
  const message = await prisma.message.findUnique({
    where: { threadId_clientNonce: { threadId, clientNonce: `chief-receipt:${requestMessageId}` } },
  });
  if (!message?.botId) return undefined;
  const blocks = MessageBlock.array().safeParse(message.blocks);
  const block = blocks.success
    ? blocks.data.find((row) => row.kind === "chief_receipt")
    : undefined;
  if (block?.kind !== "chief_receipt") return undefined;
  return {
    id: message.id,
    threadId,
    seq: message.seq,
    botId: message.botId,
    requestMessageId,
    key: block.key,
    text: block.text,
    createdAt: message.createdAt.toISOString(),
  };
}
export async function saveChiefSelection(
  tx: Prisma.TransactionClient,
  input: Scope & {
    groupId: string;
    threadId: string;
    chiefBotId: string;
    sourceMessageId: string;
    sourceRunId: string;
    taskId: string;
    operation: ChiefOperation;
  },
) {
  const facts = await loadChiefMemberFacts(tx, input, input.groupId);
  const decision = chooseChiefMember({
    chiefId: input.chiefBotId,
    operation: input.operation,
    members: facts,
    requiredComputerId:
      input.operation.purpose === "install-tool"
        ? facts.find((member) => member.id === input.chiefBotId)?.computer?.id
        : undefined,
  });
  return tx.chiefPlan.create({
    data: {
      ...input,
      policyVersion: CHIEF_POLICY_VERSION,
      decision,
      checkedFacts: facts as unknown as Prisma.InputJsonValue,
    },
  });
}
export async function loadChiefSelectionContext(
  prisma: PrismaClient,
  sourceRunId: string,
): Promise<string | undefined> {
  const plan = await prisma.chiefPlan.findFirst({
    where: { sourceRunId },
    orderBy: { createdAt: "desc" },
  });
  if (!plan) return undefined;
  const decision = plan.decision as ChiefDecision;
  const choice =
    decision.kind === "delegate" || decision.kind === "queue"
      ? `Use handoff_to_bot with bot_id ${JSON.stringify(decision.memberId)}. Do not ask the owner to name a member.`
      : decision.kind === "self"
        ? "Prepare this work yourself; do not self-handoff."
        : "Plan the next step using the saved member facts; unknown capability is not a grant.";
  return `System receipt already shown. Do not repeat the acknowledgement. Chief policy ${plan.policyVersion}, request ${plan.sourceMessageId}, revision ${plan.revision}. ${choice} Selection is preparation, not approval for a write or installation. The dispatch boundary rechecks eligibility. Fixed pins and existing budgets remain unchanged.`;
}
/** Called under the existing owned-group lock, immediately before shared delegation admission. */
export async function validateChiefDispatch(
  tx: Prisma.TransactionClient,
  scope: Scope & { id: string; botId: string; threadId: string },
  groupId: string,
  memberId: string,
): Promise<{ error: string } | { planId?: string; dispatch?: ChiefDispatch }> {
  const plan = await tx.chiefPlan.findFirst({
    where: {
      sourceRunId: scope.id,
      ...{
        spaceId: scope.spaceId,
        userId: scope.userId,
        threadId: scope.threadId,
        groupId,
        chiefBotId: scope.botId,
      },
    },
    orderBy: { createdAt: "desc" },
  });
  if (!plan) return {};
  const operation = plan.operation as ChiefOperation;
  const saved = plan.decision as ChiefDecision;
  const facts = await loadChiefMemberFacts(tx, scope, groupId);
  if (operation.purpose !== "general") {
    if ((saved.kind !== "delegate" && saved.kind !== "queue") || saved.memberId !== memberId)
      return {
        error: "Use the chief's saved eligible choice, or plan again; no unchecked replacement.",
      };
    const current = chooseChiefMember({
      chiefId: scope.botId,
      operation,
      members: facts.filter((member) => member.id === memberId),
      requiredComputerId:
        operation.purpose === "install-tool"
          ? facts.find((member) => member.id === scope.botId)?.computer?.id
          : undefined,
    });
    if (current.kind !== "delegate" && current.kind !== "queue")
      return {
        error:
          "The selected member is no longer eligible. Plan again without dispatching a replacement.",
      };
    const previous = (plan.checkedFacts as unknown as ChiefMemberFacts[]).find(
      (member) => member.id === memberId,
    );
    const member = facts.find((member) => member.id === memberId)!;
    if (
      !previous ||
      previous.membershipRevision !== member.membershipRevision ||
      previous.pin.revision !== member.pin.revision
    )
      return { error: "The selected member's membership or pin changed. Plan again." };
  }
  const member = facts.find((candidate) => candidate.id === memberId);
  if (!member?.authorized) return { error: "The target is no longer an authorized room member." };
  // General planning retains the existing runtime/boot admission checks; local preparation
  // constraints apply only to a saved operation-specific choice, checked above.
  return {
    planId: plan.id,
    dispatch: {
      requestMessageId: plan.sourceMessageId,
      revision: plan.revision,
      memberId,
      memberName: member.name,
      state:
        member.activeRuns >= member.runLimit || member.computer?.leaseBusy ? "queued" : "messaged",
      reason:
        saved.kind === "delegate" || saved.kind === "queue"
          ? saved.reason
          : "chief planning choice validated against current membership",
    },
  };
}
