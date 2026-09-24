import { randomUUID } from "node:crypto";
import type { DocumentRevision, LearningObservation, LearningProposal } from "@ardurbot/contracts";
import { learningObservationSummary } from "@ardurbot/contracts";
import {
  extractForcedSkillName,
  extractRoutineSkillMentions,
  redactLearningText,
} from "@ardurbot/core";
import type { Prisma, PrismaClient } from "@ardurbot/db";
import { proposalView } from "./learning-apply.js";
import { consolidateLearning } from "./learning-consolidation.js";
import { learningMember } from "./learning-grants.js";
import { observeLearningRevision } from "./learning-outcomes.js";
import { reviewerDestination } from "./learning-pin.js";
import { policyCandidates, policySuppressed } from "./learning-policy.js";
import { proposalFingerprint } from "./learning-proposal.js";
import { learningHash } from "./learning-records.js";
import type { LearningReviewDependencies } from "./learning-review.js";
import { skillDocumentContext } from "./skill-documents.js";

type Identity = { spaceId: string; userId: string };
export function learnedSkillStale(
  input: {
    origin: string;
    protected: boolean;
    routineLinked: boolean;
    lifecycleTag: string;
    revisionCreatedAt: Date;
    lastExposureAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    input.origin === "learned" &&
    !input.protected &&
    !input.routineLinked &&
    !["recovery", "troubleshooting"].includes(input.lifecycleTag) &&
    Math.max(input.lastExposureAt?.getTime() ?? 0, input.revisionCreatedAt.getTime()) <=
      now.getTime() - 30 * 86400000
  );
}
export function possibleLearningRegression(o: LearningObservation): boolean {
  const after = o.correctionsAfter.feedback + o.correctionsAfter.steering;
  const before = o.before.corrections.feedback + o.before.corrections.steering;
  return (
    o.before.comparableExposedRuns === o.exposedRuns &&
    after >= 3 &&
    o.exposedRuns >= 5 &&
    o.before.runs >= 5 &&
    after * o.before.runs > before * o.exposedRuns
  );
}
/** Persist proposals and evidence under the same history-generation lock as P1. Never applies them. */
export async function saveCuratorProposal(
  prisma: PrismaClient,
  input: {
    proposal: LearningProposal;
    runId: string;
    threadId: string;
    historyGeneration: number;
  },
  now: Date,
): Promise<boolean> {
  const { proposal, runId, threadId, historyGeneration } = input;
  const identity = { spaceId: proposal.scope.spaceId, userId: proposal.scope.userId! };
  const fingerprint = proposalFingerprint(proposal);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${identity.spaceId} FOR UPDATE`;
    await learningMember(tx, identity, proposal.scope.botId);
    const locked = await tx.thread.updateMany({
      where: { id: threadId, ...identity, historyCompactionGeneration: historyGeneration },
      data: { historyCompactionGeneration: historyGeneration },
    });
    if (locked.count !== 1) return false;
    const suppressed = await tx.learningSuppression.findUnique({
      where: { spaceId_userId_fingerprint: { ...identity, fingerprint } },
    });
    if (
      suppressed &&
      (proposal.type !== "policy-suggestion" || policySuppressed(suppressed.createdAt, now))
    )
      return false;
    const existing = await tx.learningProposal.findMany({
      where: { ...identity, botId: proposal.scope.botId, fingerprint },
    });
    if (
      existing.some((p) => p.status === "applied" || (p.status === "pending" && p.expiresAt > now))
    )
      return false;
    await tx.learningProposal.create({
      data: {
        id: proposal.id,
        ...identity,
        botId: proposal.scope.botId!,
        runId,
        threadId,
        historyGeneration,
        fingerprint,
        status: "pending",
        body: proposal as Prisma.InputJsonValue,
        expiresAt: new Date(proposal.expiresAt),
      },
    });
    const evidenceId = proposal.evidenceIds[0]!;
    await tx.proposalEvidence.create({
      data: {
        id: evidenceId,
        ...identity,
        runId,
        threadId,
        historyGeneration,
        body: {
          id: evidenceId,
          kind: "observed-outcome",
          sourceClass: proposal.type === "policy-suggestion" ? "approval" : "run",
          runId,
          threadId,
          eventIds: [],
          redactionVersion: 1,
          outcome: { category: "feedback", classification: "unknown" },
        },
      },
    });
    await tx.reviewExecution.create({
      data: {
        idempotencyKey: `curator:${proposal.id}`,
        ...identity,
        botId: proposal.scope.botId!,
        runId,
        threadId,
        historyGeneration,
        evidenceWatermark: evidenceId,
        policyVersion: "curator-1",
        status: "proposed",
        tokens: 0,
        reviewerPin: proposal.provenance!.reviewerPin,
        proposalIds: [proposal.id],
        completedAt: now,
      },
    });
    await tx.learningAudit.create({
      data: {
        ...identity,
        proposalId: proposal.id,
        action:
          proposal.operation === "revert-suggestion"
            ? "curator-regression"
            : proposal.operation === "consolidation"
              ? "curator-consolidation"
              : "curator-policy",
        category: proposal.type,
        scopeKey: `bot:${proposal.scope.botId}`,
        beforeRevisionId: proposal.observation?.revisionId,
      },
    });
    return true;
  });
}
export async function runLearningCurator(
  deps: LearningReviewDependencies,
  actor: Identity,
  id: string = randomUUID(),
  now = new Date(),
) {
  await learningMember(deps.prisma, actor);
  const claim = await deps.prisma.learningCuratorRun.createMany({
    data: [{ id, ...actor, startedAt: now }],
    skipDuplicates: true,
  });
  if (!claim.count) return;
  const started = Date.now();
  const report = {
    checked: 0,
    staleIds: [] as string[],
    flaggedIds: [] as string[],
    proposalIds: [] as string[],
    tokens: 0 as number | null,
  };
  try {
    const config = await deps.prisma.spaceLearningConfig.findUnique({
      where: { spaceId: actor.spaceId },
    });
    const pin = await reviewerDestination(
      deps.prisma,
      { ...actor, userId: config?.configuredBy ?? actor.userId },
      config?.reviewerPin,
    );
    const skills = await deps.prisma.agentSkill.findMany({
      where: { ...actor, origin: "learned" },
    });
    const routines = await deps.prisma.routine.findMany({
      where: actor,
      select: { botId: true, prompt: true },
    });
    const eligible: DocumentRevision[] = [];
    for (const skill of skills) {
      if (!skill.documentId || !deps.memoryDocuments) continue;
      const context = skillDocumentContext({ ...actor, botId: skill.botId ?? undefined });
      const head = await deps.memoryDocuments.read(skill.documentId, context);
      if (!head || head.deletedAt) continue;
      report.checked++;
      const exposure = await deps.prisma.runKnowledgeExposure.findFirst({
        where: { documentId: skill.documentId, thread: { ...actor } },
        orderBy: { createdAt: "desc" },
      });
      const routineLinked = routines.some(
        (r) =>
          (!skill.botId || r.botId === skill.botId) &&
          [
            ...extractRoutineSkillMentions(r.prompt, [skill.name]),
            extractForcedSkillName(r.prompt)?.name,
          ].some((n) => n?.toLowerCase() === skill.name.toLowerCase()),
      );
      const stale = learnedSkillStale(
        {
          ...skill,
          routineLinked,
          revisionCreatedAt: new Date(head.createdAt),
          lastExposureAt: exposure?.createdAt ?? null,
        },
        now,
      );
      await deps.prisma.agentSkill.updateMany({
        where: {
          id: skill.id,
          ...actor,
          protected: skill.protected,
          lifecycleTag: skill.lifecycleTag,
        },
        data: { staleAt: stale ? (skill.staleAt ?? now) : null },
      });
      if (stale) {
        report.staleIds.push(skill.id);
        if (!skill.staleAt)
          await deps.prisma.learningAudit.create({
            data: {
              ...actor,
              action: "curator-stale",
              scopeKey: skill.botId ? `bot:${skill.botId}` : "user",
              beforeRevisionId: `${head.id}:${head.revision}`,
            },
          });
      }
      if (!skill.protected && !routineLinked) eligible.push(head);
    }
    const applied = await deps.prisma.learningProposal.findMany({
      where: { ...actor, status: "applied", appliedRevisionId: { not: null } },
    });
    for (const row of applied) {
      const original = proposalView(row);
      if (
        !["memory", "skill"].includes(original.type) ||
        original.operation === "revert-suggestion" ||
        !original.documentId ||
        !deps.memoryDocuments
      )
        continue;
      const context = skillDocumentContext({ ...actor, botId: row.botId });
      const revisionNumber = Number(row.appliedRevisionId!.split(":").at(-1));
      const history = await deps.memoryDocuments.history(
        original.documentId,
        { cursor: revisionNumber + 1, limit: 1 },
        context,
      );
      const revision = history.items.find((r) => r.revision === revisionNumber);
      if (!revision) continue;
      const observation = await observeLearningRevision(deps.prisma, revision, now);
      if (!possibleLearningRegression(observation)) continue;
      report.flaggedIds.push(row.appliedRevisionId!);
      const source = await deps.prisma.run.findUnique({
        where: { id: row.runId },
        include: { thread: true },
      });
      if (!source) continue;
      const proposal: LearningProposal = {
        type: original.type,
        operation: "revert-suggestion",
        revertsProposalId: original.id,
        scope: original.scope,
        target: { documentId: original.documentId },
        expectedBaseRevision: revisionNumber,
        proposedContent: "",
        rationale: `Possible regression. ${learningObservationSummary(observation)}. Propose undoing this revision.`,
        evidenceIds: [randomUUID()],
        observation,
        id: randomUUID(),
        diff: `Proposed revert of ${row.appliedRevisionId}`,
        status: "pending",
        expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
        provenance: {
          runId: row.runId,
          originatingPin: original.provenance?.originatingPin ?? null,
          reviewerPin: pin,
          policyVersion: "curator-1",
        },
      };
      if (
        await saveCuratorProposal(
          deps.prisma,
          {
            proposal,
            runId: row.runId,
            threadId: row.threadId,
            historyGeneration: row.historyGeneration,
          },
          now,
        )
      )
        report.proposalIds.push(proposal.id);
    }
    const approvals = await deps.prisma.externalEffect.findMany({
      where: {
        spaceId: actor.spaceId,
        decision: "allow",
        decisionByUserId: actor.userId,
        decisionAt: { gte: new Date(now.getTime() - 14 * 86400000), lt: now },
        run: { ...actor },
      },
      include: { run: { include: { bot: true, thread: true } } },
    });
    for (const candidate of policyCandidates(
      approvals.map((a) => ({
        id: a.id,
        botId: a.run.botId,
        tool: a.kind,
        at: a.decisionAt!,
        userId: a.decisionByUserId!,
      })),
      actor.userId,
      now,
    )) {
      const source = approvals.find(
        (a) => a.run.botId === candidate.botId && a.kind === candidate.tool,
      )!;
      const scope = { ...actor, botId: candidate.botId };
      const proposal: LearningProposal = {
        id: randomUUID(),
        type: "policy-suggestion",
        policyTool: candidate.tool,
        scope,
        target: { settingKey: "approval.tool" },
        typedDelta: { key: "approval.tool", value: candidate.tool },
        rationale: redactLearningText(
          `You allowed ${candidate.tool} ${candidate.count} times for ${source.run.bot.name} — allow it for this bot?`,
        ),
        evidenceIds: [randomUUID()],
        diff: `Allow ${candidate.tool} for this bot only.`,
        status: "pending",
        expiresAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
        provenance: {
          runId: source.runId,
          originatingPin: null,
          reviewerPin: pin,
          policyVersion: "curator-1",
        },
      };
      if (
        await saveCuratorProposal(
          deps.prisma,
          {
            proposal,
            runId: source.runId,
            threadId: source.run.threadId,
            historyGeneration: source.run.thread.historyCompactionGeneration,
          },
          now,
        )
      )
        report.proposalIds.push(proposal.id);
    }
    if (config?.enabled && config.consolidationEnabled) {
      const result = await consolidateLearning(deps, actor, eligible, config, now);
      report.tokens = result.tokens;
      report.proposalIds.push(...result.proposalIds);
      if (result.failed) throw new Error("Consolidation failed.");
    }
    await deps.prisma.learningCuratorRun.update({
      where: { id },
      data: {
        ...report,
        status: "completed",
        completedAt: new Date(),
        durationMs: Date.now() - started,
      },
    });
  } catch {
    await deps.prisma.learningCuratorRun.update({
      where: { id },
      data: {
        ...report,
        status: "failed",
        completedAt: new Date(),
        durationMs: Date.now() - started,
      },
    });
  }
}
export async function curateLearningSpaces(
  deps: LearningReviewDependencies,
  payload: { spaceId?: string; requestedBy?: string; requestId?: string },
) {
  const configs = await deps.prisma.spaceLearningConfig.findMany({
    where: payload.spaceId ? { spaceId: payload.spaceId } : { enabled: true },
  });
  for (const config of configs) {
    if (payload.requestedBy) {
      const owner = await deps.prisma.spaceMember.findUnique({
        where: { spaceId_userId: { spaceId: config.spaceId, userId: payload.requestedBy } },
      });
      if (
        !owner?.role
          .split(",")
          .map((r) => r.trim())
          .includes("owner")
      )
        continue;
    }
    const members = await deps.prisma.spaceMember.findMany({ where: { spaceId: config.spaceId } });
    for (const member of members) {
      const week = Math.floor(Date.now() / (7 * 86400000));
      await runLearningCurator(
        deps,
        { spaceId: config.spaceId, userId: member.userId },
        learningHash([payload.requestId ?? week, config.spaceId, member.userId]),
      );
    }
  }
}
