/** Fields the learning screens use to tell one item from another. */
export type LearningItemTextSource = {
  type?: string;
  rationale: string;
  proposedContent?: string | null;
  typedDelta?: { key: string } | null;
  boardItem?: { title?: string | null } | null;
};

/** The line a person uses to tell this item apart. The review reason stays separate. */
export function learningItemTitle(proposal: LearningItemTextSource): string {
  if (proposal.type === "policy-suggestion") return proposal.rationale;
  if (proposal.type === "board-item") return proposal.boardItem?.title || proposal.rationale;
  const line = proposal.proposedContent?.split("\n").find((entry) => {
    const trimmed = entry.trim();
    return trimmed.length > 0 && trimmed !== "---";
  });
  return line?.trim() || proposal.typedDelta?.key || proposal.rationale;
}
