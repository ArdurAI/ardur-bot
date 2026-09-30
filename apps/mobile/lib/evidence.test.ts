import type { EvidenceRunSummary } from "@ardurbot/contracts/evidence";
import { EVIDENCE_STATE_IDS, EVIDENCE_STATES } from "@ardurbot/contracts/evidence-states";
import { afterEach, describe, expect, it } from "vitest";
import { mobileEvidencePresentation } from "./evidence";
import { resetI18nForTests, t } from "./i18n";
import { RU_MESSAGES } from "./locales/ru";
import { ZH_MESSAGES } from "./locales/zh";

function summary(state: EvidenceRunSummary["state"]): EvidenceRunSummary {
  return {
    sessionId: "run",
    recordedAt: "2026-09-29T12:00:00Z",
    decisions: { allowed: 0, denied: 0, asked: 0, recorded: 0 },
    captureLevel: "decisions",
    evidence: null,
    gates: { spend: null, risks: [] },
    state,
    sealed: state === "verified" || state === "gap",
    gapCount: state === "gap" ? 2 : 0,
    failureCodes: state === "failed" ? ["signature_invalid"] : [],
  };
}
afterEach(() => resetI18nForTests());
describe("mobile evidence state mapping", () => {
  it.each(EVIDENCE_STATE_IDS)("uses the shared label and icon for %s", (state) => {
    const result = mobileEvidencePresentation(summary(state));
    if (state === "off") {
      expect(result).toBeNull();
      return;
    }
    expect(result).toMatchObject({
      label: EVIDENCE_STATES[state].labelMessageId,
      icon: EVIDENCE_STATES[state].icon,
      downloadable: state === "verified" || state === "gap",
    });
  });
  it("reports gaps and only failure codes", () => {
    expect(mobileEvidencePresentation(summary("gap"))?.detail).toBe("2 evidence gaps");
    expect(mobileEvidencePresentation(summary("failed"))?.detail).toBe("signature_invalid");
  });
  it.each(["ru", "zh-CN"] as const)(
    "translates shared state labels and actions in %s",
    (locale) => {
      resetI18nForTests(locale);
      const catalog = locale === "ru" ? RU_MESSAGES : ZH_MESSAGES;
      for (const entry of Object.values(EVIDENCE_STATES)) {
        expect(catalog[entry.labelMessageId]).toBeTruthy();
        expect(t(entry.labelMessageId)).not.toBe(entry.labelMessageId);
      }
      for (const id of [
        "Download evidence",
        "{gapCount} evidence gaps",
        "The export could not finish; try again.",
      ])
        expect(catalog[id]).toBeTruthy();
      expect(catalog["{gapCount} evidence gaps"]).toContain("{gapCount}");
      expect(mobileEvidencePresentation(summary("gap"))?.detail).toContain("2");
    },
  );
});
