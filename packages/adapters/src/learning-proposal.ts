import type { LearningCandidate } from "@ardurbot/contracts";
import { learningHash } from "./learning-records.js";
export function proposalFingerprint(candidate: LearningCandidate) {
  return learningHash([
    candidate.type,
    [candidate.scope.spaceId, candidate.scope.userId ?? null, candidate.scope.botId ?? null],
    [candidate.target.documentId ?? null, candidate.target.settingKey ?? null],
    candidate.proposedContent?.trim(),
    candidate.typedDelta ? [candidate.typedDelta.key, candidate.typedDelta.value] : null,
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
