import { randomUUID } from "node:crypto";
import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import {
  createLearningApplyService,
  createLearningGrants,
  enqueueLearningReview,
  learningMember,
  observeLearningRevision,
  proposalView,
  reviewerDestination,
  skillDocumentContext,
} from "@ardurbot/adapters";
import type { Actor, SpaceLearningConfig } from "@ardurbot/contracts";
import {
  CuratorReportSchema,
  ProposalEvidenceSchema,
  ReviewExecutionSchema,
  SpaceLearningConfigInput,
} from "@ardurbot/contracts";
import { learningJourney } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import type { MemoryService } from "@ardurbot/memory";
import { requireSpaceOwner } from "./memory-provider-config.js";

export function createLearningService(deps: {
  prisma: PrismaClient;
  jobs: JobPublisher;
  memoryDocuments?: MemoryService;
  secrets?: EncryptedSecretStore;
}) {
  async function settings(actor: Actor): Promise<SpaceLearningConfig> {
    const member = await learningMember(deps.prisma, {
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    const row = await deps.prisma.spaceLearningConfig.findUnique({
      where: { spaceId: actor.spaceId },
    });
    const config = SpaceLearningConfigInput.parse(
      row
        ? {
            enabled: row.enabled,
            consolidationEnabled: row.consolidationEnabled,
            reviewerPin: row.reviewerPin,
            budgets: {
              botDailyTokens: row.botDailyTokens,
              spaceDailyTokens: row.spaceDailyTokens,
              maxProposals: row.maxProposals,
              timeoutMs: row.timeoutMs,
              maxOutputTokens: row.maxOutputTokens,
              maxOutputChars: row.maxOutputChars,
            },
          }
        : {},
    );
    return {
      ...config,
      canConfigure: member.role
        .split(",")
        .map((role) => role.trim())
        .includes("owner"),
      destination: await reviewerDestination(
        deps.prisma,
        { spaceId: actor.spaceId, userId: row?.configuredBy ?? actor.userId },
        config.reviewerPin,
      ),
    };
  }
  async function summary(actor: Actor, botId?: string) {
    await learningMember(deps.prisma, { spaceId: actor.spaceId, userId: actor.userId }, botId);
    const where = { spaceId: actor.spaceId, userId: actor.userId, ...(botId ? { botId } : {}) };
    const [pendingCount, appliedThisWeek] = await Promise.all([
      deps.prisma.learningProposal.count({
        where: { ...where, status: "pending", expiresAt: { gt: new Date() } },
      }),
      deps.prisma.learningProposal.count({
        where: {
          ...where,
          status: "applied",
          appliedAt: { gte: new Date(Date.now() - 7 * 86400000) },
        },
      }),
    ]);
    return { pendingCount, appliedThisWeek };
  }
  const identity = (actor: Actor) => ({ spaceId: actor.spaceId, userId: actor.userId });
  const grants = createLearningGrants(deps.prisma);
  const apply = () => {
    if (!deps.secrets) throw new Error("Learning changes are unavailable.");
    return createLearningApplyService({ ...deps, secretStore: deps.secrets });
  };
  async function observation(actor: Actor, documentId: string, revision: number) {
    await learningMember(deps.prisma, identity(actor));
    if (!deps.memoryDocuments) throw new Error("Document storage is unavailable.");
    const history = await deps.memoryDocuments.history(
      documentId,
      { cursor: revision + 1, limit: 1 },
      skillDocumentContext(identity(actor)),
    );
    const selected = history.items.find((r) => r.revision === revision);
    if (!selected) throw new IsolationError();
    return observeLearningRevision(deps.prisma, selected);
  }
  async function journeyData(actor: Actor, botId?: string) {
    await learningMember(deps.prisma, identity(actor), botId);
    const bundle = await deps.memoryDocuments?.exportBundle(skillDocumentContext(identity(actor)));
    const revisions = (bundle?.documents ?? [])
      .flatMap((d) => d.revisions)
      .filter((r) => !botId || (r.scopeKey.kind === "bot" && r.scopeKey.botId === botId));
    const audits = await deps.prisma.learningAudit.findMany({
      where: { ...identity(actor), ...(botId ? { scopeKey: `bot:${botId}` } : {}) },
      orderBy: { createdAt: "desc" },
    });
    return { entries: learningJourney(revisions, audits), revisions };
  }
  async function journey(actor: Actor, botId?: string) {
    return (await journeyData(actor, botId)).entries;
  }
  async function exportLearning(actor: Actor, botId: string) {
    const { entries, revisions } = await journeyData(actor, botId);
    const ids = new Set(entries.flatMap((e) => (e.revisionId ? [e.revisionId] : [])));
    const observations = [];
    for (const revision of revisions.filter((r) => ids.has(`${r.documentId}:${r.revision}`)))
      observations.push(await observeLearningRevision(deps.prisma, revision));
    return { journey: entries, observations };
  }
  return {
    observation,
    journey,
    exportLearning,
    async proposal(actor: Actor, proposalId: string) {
      await learningMember(deps.prisma, identity(actor));
      const row = await deps.prisma.learningProposal.findFirst({
        where: { id: proposalId, ...identity(actor) },
      });
      if (!row) throw new IsolationError();
      await learningMember(deps.prisma, identity(actor), row.botId);
      const proposal = proposalView(row);
      if (proposal.status === "pending" && new Date(proposal.expiresAt) <= new Date())
        proposal.status = "expired";
      return proposal;
    },
    assertBot: (actor: Actor, botId: string) => learningMember(deps.prisma, identity(actor), botId),
    async curator(actor: Actor) {
      await requireSpaceOwner(deps.prisma, actor);
      const [reports, skills] = await Promise.all([
        deps.prisma.learningCuratorRun.findMany({
          where: { spaceId: actor.spaceId },
          orderBy: { startedAt: "desc" },
          take: 20,
        }),
        deps.prisma.agentSkill.findMany({
          where: { ...identity(actor), origin: "learned" },
          select: { id: true, name: true, staleAt: true, lifecycleTag: true },
        }),
      ]);
      return {
        reports: reports.map((r) =>
          CuratorReportSchema.parse({
            ...r,
            startedAt: r.startedAt.toISOString(),
            completedAt: r.completedAt?.toISOString() ?? null,
          }),
        ),
        skills: skills.map((s) => ({ ...s, staleAt: s.staleAt?.toISOString() ?? null })),
      };
    },
    async curate(actor: Actor) {
      await requireSpaceOwner(deps.prisma, actor);
      if (
        !(await deps.prisma.spaceLearningConfig.findUnique({ where: { spaceId: actor.spaceId } }))
      )
        await deps.prisma.spaceLearningConfig.create({
          data: { spaceId: actor.spaceId, configuredBy: actor.userId },
        });
      await deps.jobs.enqueue({
        name: "learning.curate",
        payload: { spaceId: actor.spaceId, requestedBy: actor.userId, requestId: randomUUID() },
        replaceKey: `learning.curate:${actor.spaceId}`,
      });
      return { ok: true as const };
    },
    async skillCare(
      actor: Actor,
      skillId: string,
      lifecycleTag: "normal" | "recovery" | "troubleshooting",
    ) {
      await learningMember(deps.prisma, identity(actor));
      const updated = await deps.prisma.agentSkill.updateMany({
        where: { id: skillId, ...identity(actor), origin: "learned" },
        data: { lifecycleTag, staleAt: null },
      });
      if (updated.count !== 1) throw new IsolationError();
      return { ok: true as const };
    },
    summary,
    settings,
    grants: (actor: Actor) => grants.list({ spaceId: actor.spaceId, userId: actor.userId }),
    createGrant: (actor: Actor, input: Parameters<typeof grants.create>[1]) =>
      grants.create(identity(actor), input),
    revokeGrant: (actor: Actor, id: string) => grants.revoke(identity(actor), id),
    declineGrant: (actor: Actor, input: Parameters<typeof grants.decline>[1]) =>
      grants.decline(identity(actor), input),
    approve: (...args: Parameters<ReturnType<typeof createLearningApplyService>["approve"]>) =>
      apply().approve(args[0], identity(args[1] as Actor), args[2]),
    reject: (...args: Parameters<ReturnType<typeof createLearningApplyService>["reject"]>) =>
      apply().reject(args[0], identity(args[1] as Actor), args[2]),
    edit: (...args: Parameters<ReturnType<typeof createLearningApplyService>["edit"]>) =>
      apply().edit(args[0], identity(args[1] as Actor), args[2]),
    revert: (...args: Parameters<ReturnType<typeof createLearningApplyService>["revert"]>) =>
      apply().revert(args[0], identity(args[1] as Actor)),
    async evidence(actor: Actor, proposalId: string, evidenceId: string) {
      await learningMember(deps.prisma, { spaceId: actor.spaceId, userId: actor.userId });
      const row = await deps.prisma.learningProposal.findFirst({
        where: { id: proposalId, spaceId: actor.spaceId, userId: actor.userId },
      });
      if (!row || !proposalView(row).evidenceIds.includes(evidenceId)) throw new IsolationError();
      const source = await deps.prisma.thread.findFirst({
        where: {
          id: row.threadId,
          spaceId: actor.spaceId,
          userId: actor.userId,
          historyCompactionGeneration: row.historyGeneration,
        },
      });
      const evidence =
        source &&
        (await deps.prisma.proposalEvidence.findFirst({
          where: {
            id: evidenceId,
            spaceId: actor.spaceId,
            userId: actor.userId,
            threadId: row.threadId,
            historyGeneration: row.historyGeneration,
          },
        }));
      if (!evidence) throw new IsolationError();
      return ProposalEvidenceSchema.parse(evidence.body);
    },
    async configure(actor: Actor, input: unknown) {
      await requireSpaceOwner(deps.prisma, actor);
      const config = SpaceLearningConfigInput.parse(input);
      // Capture the selected default once, including medium effort. Subsequent default changes do not repin it.
      const pin = config.enabled
        ? await reviewerDestination(deps.prisma, actor, config.reviewerPin)
        : config.reviewerPin;
      const data = {
        enabled: config.enabled,
        consolidationEnabled: config.consolidationEnabled,
        ...(pin ? { reviewerPin: pin } : {}),
        configuredBy: actor.userId,
        ...config.budgets,
      };
      await deps.prisma.spaceLearningConfig.upsert({
        where: { spaceId: actor.spaceId },
        create: { spaceId: actor.spaceId, ...data },
        update: data,
      });
      return settings(actor);
    },
    async list(actor: Actor, botId?: string) {
      await learningMember(deps.prisma, { spaceId: actor.spaceId, userId: actor.userId }, botId);
      const where = { spaceId: actor.spaceId, userId: actor.userId, ...(botId ? { botId } : {}) };
      const [reviews, proposals, counts] = await Promise.all([
        deps.prisma.reviewExecution.findMany({
          where: { ...where, completedAt: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        deps.prisma.learningProposal.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 }),
        summary(actor, botId),
      ]);
      const bots = await deps.prisma.bot.findMany({
        where: { spaceId: actor.spaceId, userId: actor.userId },
        select: { id: true, name: true },
      });
      return {
        botNames: Object.fromEntries(bots.map((bot) => [bot.id, bot.name])),
        reviews: reviews.map((row) => ReviewExecutionSchema.parse(row)),
        proposals: proposals.map((row) => {
          const proposal = proposalView(row);
          if (proposal.status === "pending" && new Date(proposal.expiresAt) <= new Date())
            proposal.status = "expired";
          return proposal;
        }),
        ...counts,
      };
    },
    async review(actor: Actor, runId: string) {
      const run = await deps.prisma.run.findFirst({
        where: { id: runId, spaceId: actor.spaceId, userId: actor.userId },
      });
      if (!run) throw new IsolationError();
      await enqueueLearningReview(deps, run.id);
      return { ok: true as const };
    },
  };
}
