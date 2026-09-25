import type { DocumentRevision, LearningJourneyEntry } from "@ardurbot/contracts";

export interface JourneyAudit {
  id: string;
  createdAt: Date;
  action: string;
  scopeKey: string | null;
  proposalId: string | null;
  grantId: string | null;
  beforeRevisionId: string | null;
  afterRevisionId: string | null;
}
/** Immutable revisions and durable audits are the clocks; filesystem dates never enter this projection. */
export function learningJourney(
  revisions: DocumentRevision[],
  audits: JourneyAudit[],
): LearningJourneyEntry[] {
  const entries: LearningJourneyEntry[] = revisions
    .filter((r) => r.author.kind === "learning-loop" || r.learning || r.imported)
    .map((r) => ({
      id: `revision:${r.documentId}:${r.revision}`,
      at: r.createdAt,
      action: r.imported
        ? r.deletedAt
          ? "import-removed"
          : "imported"
        : r.learning?.action === "revert"
          ? "revert"
          : "applied",
      importedFrom: r.imported?.tool,
      botId: r.scopeKey.kind === "bot" ? r.scopeKey.botId : undefined,
      proposalId: r.learning?.proposalId,
      revisionId: `${r.documentId}:${r.revision}`,
      documentId: r.documentId,
      grantId: r.learning?.grantId,
    }));
  for (const a of audits) {
    if (
      ![
        "approve",
        "auto-apply",
        "revert",
        "approve-revert",
        "approve-policy",
        "grant-created",
        "grant-revoked",
        "curator-stale",
        "curator-regression",
        "curator-consolidation",
        "curator-policy",
      ].includes(a.action)
    )
      continue;
    if (
      ["approve", "auto-apply", "revert"].includes(a.action) &&
      a.afterRevisionId &&
      entries.some((e) => e.revisionId === a.afterRevisionId)
    )
      continue;
    const revisionId = a.afterRevisionId ?? a.beforeRevisionId ?? undefined;
    entries.push({
      id: `audit:${a.id}`,
      at: a.createdAt.toISOString(),
      action: a.action,
      botId: a.scopeKey?.startsWith("bot:") ? a.scopeKey.slice(4) : undefined,
      proposalId: a.proposalId ?? undefined,
      grantId: a.grantId ?? undefined,
      revisionId,
      documentId: revisionId?.split(":")[0],
    });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
