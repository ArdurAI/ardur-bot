export type EvidenceStateFacts = {
  recordCount: number;
  finished: boolean;
  sealed: boolean;
  verificationFailed: boolean;
  gapCount: number;
};

type EvidenceStateEntry = {
  labelMessageId: string;
  icon: "circle" | "loader" | "shield-check" | "shield-alert" | "shield" | "shield-x";
  matches: (facts: EvidenceStateFacts) => boolean;
};

/** Ordered rules: verification failure takes precedence over recording or sealing. */
export const EVIDENCE_STATES = {
  off: {
    labelMessageId: "Evidence off",
    icon: "circle",
    matches: (f) => f.recordCount === 0 && !f.sealed && f.gapCount === 0,
  },
  failed: {
    labelMessageId: "Check failed",
    icon: "shield-x",
    matches: (f) => f.verificationFailed,
  },
  recording: {
    labelMessageId: "Recording",
    icon: "loader",
    matches: (f) => !f.finished,
  },
  unsealed: {
    labelMessageId: "Not sealed",
    icon: "shield",
    matches: (f) => !f.sealed,
  },
  gap: {
    labelMessageId: "Evidence gap",
    icon: "shield-alert",
    matches: (f) => f.gapCount > 0,
  },
  verified: {
    labelMessageId: "Verified",
    icon: "shield-check",
    matches: () => true,
  },
} as const satisfies Record<string, EvidenceStateEntry>;

export type EvidenceState = keyof typeof EVIDENCE_STATES;
export const EVIDENCE_STATE_IDS = Object.keys(EVIDENCE_STATES) as [
  EvidenceState,
  ...EvidenceState[],
];
export function evidenceState(facts: EvidenceStateFacts): EvidenceState {
  return EVIDENCE_STATE_IDS.find((state) => EVIDENCE_STATES[state].matches(facts))!;
}
