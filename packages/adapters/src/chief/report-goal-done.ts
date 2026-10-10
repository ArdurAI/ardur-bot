import { redactSecrets } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { submitGoalFromCoordinator } from "@ardurbot/db";

/** Home path: the coordinator reported the project done, so submit that result for review. */
export async function reportGoalDone(
  prisma: PrismaClient,
  input: {
    goalId: string;
    spaceId: string;
    userId: string;
    coordinatorBotId: string;
    threadId: string;
    summary: string;
  },
) {
  const summary = input.summary.trim();
  if (!summary) return { ok: false as const, error: "finish_goal requires a summary" };
  try {
    const revision = await submitGoalFromCoordinator(prisma, { ...input, summary });
    return { ok: true as const, revisionId: revision.id, status: "completed" as const };
  } catch {
    return { ok: false as const, error: "The result could not be submitted." };
  }
}

/** Redact the coordinator summary, then store that text as the revision under review. */
export async function finishGoalFromRun(
  prisma: PrismaClient,
  input: {
    goalId: string;
    spaceId: string;
    userId: string;
    coordinatorBotId: string;
    threadId: string;
    summary: string;
    secrets: readonly string[];
  },
) {
  const summary = redactSecrets(String(input.summary ?? ""), [...input.secrets]).trim();
  if (!summary) return { ok: false as const, error: "finish_goal requires a summary" };
  return reportGoalDone(prisma, { ...input, summary });
}
