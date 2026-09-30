function member<const T extends readonly string[]>(table: T, value: unknown): value is T[number] {
  return typeof value === "string" && table.includes(value);
}

export const ACTION_CLASSES = [
  "search",
  "read",
  "write",
  "query",
  "delegate",
  "send",
  "summarize",
  "observe",
  "execute",
  "dispatch",
  "fetch",
  "invoke",
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];
export const isActionClass = (value: unknown): value is ActionClass =>
  member(ACTION_CLASSES, value);
export const SIDE_EFFECT_CLASSES = [
  "none",
  "internal_write",
  "external_send",
  "state_change",
  "filesystem_write",
  "process_launch",
  "network_read",
  "subagent_launch",
] as const;
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number];
export const isSideEffectClass = (value: unknown): value is SideEffectClass =>
  member(SIDE_EFFECT_CLASSES, value);
export const VERDICTS = ["compliant", "violation", "insufficient_evidence", "unknown"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const isVerdict = (value: unknown): value is Verdict => member(VERDICTS, value);
export const EVIDENCE_LEVELS = ["self_signed", "counter_signed", "transparency_logged"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];
export const isEvidenceLevel = (value: unknown): value is EvidenceLevel =>
  member(EVIDENCE_LEVELS, value);
export const DENIAL_REASONS = [
  "policy_denied",
  "budget_exhausted",
  "insufficient_evidence",
  "revoked",
  "chain_invalid",
  "unknown",
  "observation_gap",
] as const;
export type DenialReason = (typeof DENIAL_REASONS)[number];
export const isDenialReason = (value: unknown): value is DenialReason =>
  member(DENIAL_REASONS, value);
export const DIGEST_SCOPES = ["result", "normalized_input", "measurement", "custom"] as const;
export type DigestScope = (typeof DIGEST_SCOPES)[number];
export const isDigestScope = (value: unknown): value is DigestScope => member(DIGEST_SCOPES, value);
export const DIGEST_CANONICALIZATIONS = ["jcs-rfc8785", "none"] as const;
export type DigestCanonicalization = (typeof DIGEST_CANONICALIZATIONS)[number];
export const isDigestCanonicalization = (value: unknown): value is DigestCanonicalization =>
  member(DIGEST_CANONICALIZATIONS, value);
export const SENSITIVITIES = [
  "public",
  "internal",
  "confidential",
  "restricted",
  "regulated",
  "unknown",
] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const isSensitivity = (value: unknown): value is Sensitivity => member(SENSITIVITIES, value);

export const RECEIPT_REQUIRED_CLAIMS = [
  "schema_version",
  "canonicalization",
  "receipt_kind",
  "receipt_id",
  "grant_id",
  "parent_receipt_hash",
  "parent_receipt_id",
  "actor",
  "verifier_id",
  "step_id",
  "tool",
  "action_class",
  "target",
  "resource_family",
  "side_effect_class",
  "verdict",
  "evidence_level",
  "reason",
  "policy_decisions",
  "arguments_hash",
  "trace_id",
  "run_nonce",
  "invocation_digest",
  "budget_remaining",
  "timestamp",
  "iss",
  "iat",
  "exp",
  "jti",
] as const;
export const RECEIPT_OPTIONAL_CLAIMS = [
  "content_class",
  "content_provenance",
  "sensitivity",
  "instruction_bearing",
  "budget_delta",
  "result_hash",
  "public_denial_reason",
  "internal_denial_code",
  "evidence_proof_ref",
  "measurements",
] as const;
export const FORMAT_ERROR_CODES = [
  "missing_claim",
  "unknown_claim",
  "invalid_claim",
  "empty_chain",
  "invalid_key",
  "invalid_jws",
  "invalid_sequence",
] as const;
export type FormatErrorCode = (typeof FORMAT_ERROR_CODES)[number];
export const VERIFICATION_CODES = [
  "malformed_jws",
  "header_invalid",
  "kid_mismatch",
  "signature_invalid",
  "payload_not_canonical",
  "claims_invalid",
  "chain_broken",
  "seal_signature_invalid",
  "seal_claims_invalid",
  "seal_missing_chain_head",
  "receipt_chain_head_mismatch",
] as const;
export type VerificationCode = (typeof VERIFICATION_CODES)[number];
export const isVerificationCode = (value: unknown): value is VerificationCode =>
  member(VERIFICATION_CODES, value);
