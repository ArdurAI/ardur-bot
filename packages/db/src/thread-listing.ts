import type { MessageBlock } from "@ardurbot/contracts";
import {
  ACTIVE_RUN_STATUSES,
  isReasoningSummaryBlock,
  plainTextFromMarkdown,
} from "@ardurbot/core";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];

export const activeRunSelection = {
  where: { status: { in: activeRunStatuses } },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
} as const;

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (!block || typeof block !== "object") continue;
    const candidate = block as MessageBlock;
    if (isReasoningSummaryBlock(candidate)) continue;
    if ("text" in candidate && typeof candidate.text === "string") {
      return plainTextFromMarkdown(candidate.text);
    }
  }
  return "";
}
