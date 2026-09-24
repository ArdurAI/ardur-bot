import type { JobPublisher } from "@ardurbot/adapter-kit";
import { enqueueLearningReview, reviewerDestination } from "@ardurbot/adapters";
import type { Actor, SpaceLearningConfig } from "@ardurbot/contracts";
import {
  LearningProposalSchema,
  ReviewExecutionSchema,
  SpaceLearningConfigInput,
} from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { requireSpaceOwner } from "./memory-provider-config.js";

export function createLearningService(deps: { prisma: PrismaClient; jobs: JobPublisher }) {
  async function settings(actor: Actor): Promise<SpaceLearningConfig> {
    await requireSpaceOwner(deps.prisma, actor);
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
      destination: await reviewerDestination(
        deps.prisma,
        { spaceId: actor.spaceId, userId: row?.configuredBy ?? actor.userId },
        config.reviewerPin,
      ),
    };
  }
  return {
    settings,
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
      const where = { spaceId: actor.spaceId, userId: actor.userId, ...(botId ? { botId } : {}) };
      const [reviews, proposals] = await Promise.all([
        deps.prisma.reviewExecution.findMany({
          where: { ...where, completedAt: { not: null } },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        deps.prisma.learningProposal.findMany({ where, orderBy: { createdAt: "desc" }, take: 100 }),
      ]);
      return {
        reviews: reviews.map((row) => ReviewExecutionSchema.parse(row)),
        proposals: proposals.map((row) =>
          LearningProposalSchema.parse({ ...(row.body as object), status: row.status }),
        ),
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
