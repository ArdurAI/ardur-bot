import type { GoalConditionSupport } from "@ardurbot/contracts";
import { GoalConditionSupportSchema } from "@ardurbot/contracts";
import { redactSecrets } from "@ardurbot/core";
import type { PrismaClient } from "@ardurbot/db";
import { proposeGoalConditionSupport, submitGoalFromCoordinator } from "@ardurbot/db";

/** The coordinator may attach, per condition, the records that support it. */
export type GoalSupportProposals = readonly {
  conditionId: string;
  support: readonly GoalConditionSupport[];
}[];

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
    support?: GoalSupportProposals;
  },
) {
  const summary = input.summary.trim();
  if (!summary) return { ok: false as const, error: "finish_goal requires a summary" };
  const { support, ...submission } = input;
  try {
    const revision = await submitGoalFromCoordinator(prisma, { ...submission, summary });
    // The proposing identity is the executing run above, never model text.
    // Each reference is validated exactly like the owner path; invalid ones
    // are dropped without failing the report, and a proposal is never a verdict.
    const accepted = new Map<string, GoalConditionSupport[]>();
    for (const entry of support ?? []) {
      const conditionId = entry.conditionId.trim();
      for (const rawLink of entry.support) {
        const parsed = GoalConditionSupportSchema.safeParse(rawLink);
        if (!parsed.success) continue;
        const link = parsed.data;
        const previous = accepted.get(conditionId) ?? [];
        if (
          previous.some(
            (item) =>
              item.kind === link.kind &&
              item.recordId === link.recordId &&
              item.revision === link.revision,
          )
        )
          continue;
        const candidate = [...previous, link];
        try {
          await proposeGoalConditionSupport(prisma, {
            goalId: input.goalId,
            spaceId: input.spaceId,
            userId: input.userId,
            coordinatorBotId: input.coordinatorBotId,
            threadId: input.threadId,
            revisionId: revision.id,
            conditionId,
            support: candidate,
          });
          // The helper replaces the list, so retain only successfully validated
          // references across repeated entries for this condition.
          accepted.set(conditionId, candidate);
        } catch {
          // An invalid or unknown reference never blocks the completion report.
        }
      }
    }
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
    support?: GoalSupportProposals;
  },
) {
  const summary = redactSecrets(String(input.summary ?? ""), [...input.secrets]).trim();
  if (!summary) return { ok: false as const, error: "finish_goal requires a summary" };
  return reportGoalDone(prisma, { ...input, summary });
}
