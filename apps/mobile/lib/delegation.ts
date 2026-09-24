import type { DelegationRecord } from "@ardurbot/contracts";
export function delegationLine(
  row: Pick<DelegationRecord, "requesterName" | "actingName" | "status">,
  translate: (text: string) => string,
): string {
  const labels: Record<DelegationRecord["status"], string> = {
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    accepted: "Accepted",
    failed: "Failed",
    "cancel-requested": "Stopping",
    cancelled: "Cancelled",
  };
  return `${row.requesterName} → ${row.actingName} · ${translate(labels[row.status])}`;
}
