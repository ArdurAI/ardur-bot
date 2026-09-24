import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { EncryptedSecretStore } from "@ardurbot/adapters";
import {
  createLearningApplyService,
  createLearningGrants,
  enqueueLearningReview,
  learningMember,
  proposalView,
  reviewerDestination,
} from "@ardurbot/adapters";
import type { Actor, SpaceLearningConfig } from "@ardurbot/contracts";
import {
  ProposalEvidenceSchema,
  ReviewExecutionSchema,
  SpaceLearningConfigInput,
} from "@ardurbot/contracts";
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
  return {
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
