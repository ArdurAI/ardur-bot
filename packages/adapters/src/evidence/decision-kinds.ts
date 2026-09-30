import type { DenialReason, Verdict } from "@ardurbot/evidence";

interface DecisionFields {
  verdict: Verdict;
  public_denial_reason?: DenialReason;
  internal_denial_code?: string;
  backend: "ardur-approvals" | "ardur-auto-review";
  decision: "Allow" | "Deny" | "Ask";
  ruleId: string;
}

export const DECISION_KINDS = {
  allowed_by_rule: {
    verdict: "compliant",
    backend: "ardur-approvals",
    decision: "Allow",
    ruleId: "rule",
  },
  allowed_by_default: {
    verdict: "compliant",
    backend: "ardur-approvals",
    decision: "Allow",
    ruleId: "default",
  },
  allowed_by_auto_review: {
    verdict: "compliant",
    backend: "ardur-auto-review",
    decision: "Allow",
    ruleId: "auto_review",
  },
  approved_by_owner: {
    verdict: "compliant",
    backend: "ardur-approvals",
    decision: "Allow",
    ruleId: "owner",
  },
  asked: {
    verdict: "insufficient_evidence",
    public_denial_reason: "insufficient_evidence",
    internal_denial_code: "approval_pending",
    backend: "ardur-approvals",
    decision: "Ask",
    ruleId: "default",
  },
  denied_by_rule: {
    verdict: "violation",
    public_denial_reason: "policy_denied",
    internal_denial_code: "approval_rule_deny",
    backend: "ardur-approvals",
    decision: "Deny",
    ruleId: "rule",
  },
  denied_by_auto_review: {
    verdict: "violation",
    public_denial_reason: "policy_denied",
    internal_denial_code: "auto_review_deny",
    backend: "ardur-auto-review",
    decision: "Deny",
    ruleId: "auto_review",
  },
  denied_by_owner: {
    verdict: "violation",
    public_denial_reason: "policy_denied",
    internal_denial_code: "owner_denied",
    backend: "ardur-approvals",
    decision: "Deny",
    ruleId: "owner",
  },
  approval_expired: {
    verdict: "violation",
    public_denial_reason: "policy_denied",
    internal_denial_code: "approval_expired",
    backend: "ardur-approvals",
    decision: "Deny",
    ruleId: "expiry",
  },
  unanswered_at_run_end: {
    verdict: "violation",
    public_denial_reason: "policy_denied",
    internal_denial_code: "approval_unanswered",
    backend: "ardur-approvals",
    decision: "Deny",
    ruleId: "run_end",
  },
} as const satisfies Record<string, DecisionFields>;

export type DecisionKind = keyof typeof DECISION_KINDS;

export function decisionFields(kind: DecisionKind, ruleId?: string) {
  const { backend, decision, ruleId: source, ...fields } = DECISION_KINDS[kind];
  return {
    ...fields,
    reason: kind,
    policyDecisions: [{ backend, decision, rule_id: ruleId ?? source }],
  };
}
