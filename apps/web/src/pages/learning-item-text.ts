/** Fields the learning screens use to tell one item from another. */
export type LearningItemTextSource = {
  type?: string;
  rationale: string;
  proposedContent?: string | null;
  typedDelta?: { key: string } | null;
  boardItem?: { title?: string | null } | null;
};

const LIST_MARKER = /^[-*+](?:\s+|$)/;

/** The line a person uses to tell this item apart. The review reason stays separate. */
export function learningItemTitle(proposal: LearningItemTextSource): string {
  if (proposal.type === "policy-suggestion") return proposal.rationale;
  if (proposal.type === "board-item") return proposal.boardItem?.title || proposal.rationale;
  for (const entry of proposal.proposedContent?.split("\n") ?? []) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed === "---") continue;
    const shown = trimmed.replace(LIST_MARKER, "").trim();
    if (shown) return shown;
  }
  return proposal.typedDelta?.key || proposal.rationale;
}
