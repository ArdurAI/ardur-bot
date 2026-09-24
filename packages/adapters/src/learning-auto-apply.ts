import type { LearningApplyDependencies } from "./learning-apply.js";
import { createLearningApplyService, proposalView } from "./learning-apply.js";
import { matchingLearningGrant } from "./learning-grants.js";

/** A completed review may request an apply, but only a current personal grant authorizes it. */
export async function applyGrantedLearning(deps: LearningApplyDependencies, runId: string) {
  const rows = await deps.prisma.learningProposal.findMany({ where: { runId, status: "pending" } });
  for (const row of rows) {
    try {
      const grant = await matchingLearningGrant(
        deps.prisma,
        { spaceId: row.spaceId, userId: row.userId },
        proposalView(row),
      );
      if (!grant) continue;
      await createLearningApplyService(deps).autoApply(row.id, grant.id);
    } catch {
      // Revocation, quota and concurrent edits leave the proposal for explicit review. Never log content.
    }
  }
}
