import type { LearningCandidate, LearningProposal } from "@ardurbot/contracts";
import { learningHash } from "./learning-records.js";
export function proposalFingerprint(
  candidate: Omit<LearningCandidate, "confidence"> &
    Pick<
      LearningProposal,
      "operation" | "revertsProposalId" | "participatingRevisions" | "documentKind" | "memoryAction"
    >,
) {
  return learningHash([
    candidate.type,
    [candidate.scope.spaceId, candidate.scope.userId ?? null, candidate.scope.botId ?? null],
    [candidate.target.documentId ?? null, candidate.target.settingKey ?? null],
    candidate.proposedContent?.trim(),
    candidate.typedDelta ? [candidate.typedDelta.key, candidate.typedDelta.value] : null,
    candidate.boardItem
      ? [
          candidate.boardItem.title.trim(),
          candidate.boardItem.description,
          candidate.boardItem.acceptanceCriteria,
          candidate.boardItem.workspaceId ?? null,
        ]
      : null,
    ...(candidate.operation
      ? [
          candidate.operation,
          candidate.revertsProposalId,
          candidate.participatingRevisions,
          candidate.documentKind,
          candidate.memoryAction,
        ]
      : []),
  ]);
}
export function proposalDiff(before: string, after: string): string {
  if (before === after) return "";
  // A bounded, server-computed replacement diff; the model cannot supply its own audit.
  return [
    `--- current`,
    `+++ proposed`,
    ...before
      .slice(0, 12000)
      .split("\n")
      .map((line) => `-${line}`),
    ...after.split("\n").map((line) => `+${line}`),
  ]
    .join("\n")
    .slice(0, 40000);
}
