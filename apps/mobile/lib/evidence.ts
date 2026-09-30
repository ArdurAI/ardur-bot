import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import { EVIDENCE_STATES } from "@ardurbot/contracts/evidence-states";
import { t } from "./i18n";

export function mobileEvidencePresentation(summary: EvidenceRunSummary) {
  if (summary.state === "off") return null;
  const entry = EVIDENCE_STATES[summary.state];
  return {
    label: t(entry.labelMessageId),
    icon: entry.icon,
    detail:
      summary.state === "gap"
        ? t("{gapCount} evidence gaps", { gapCount: summary.gapCount })
        : summary.failureCodes.join(", "),
    downloadable: summary.sealed,
  };
}
