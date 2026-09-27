/** Stored summaries before this marker may contain receipts that are no longer eligible. */
export const RECEIPT_FILTERED_SUMMARY_MARKER = "[receipt-filtered-summary:v1]\n";

export function receiptFilteredSummary(stored: string | null | undefined): string | null {
  if (!stored?.startsWith(RECEIPT_FILTERED_SUMMARY_MARKER)) return null;
  return stored.slice(RECEIPT_FILTERED_SUMMARY_MARKER.length).trim() || null;
}
