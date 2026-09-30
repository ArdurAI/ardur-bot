import type { KeyObject } from "node:crypto";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import {
  BASE64URL_PATTERN,
  EvidenceFormatError,
  epochSeconds,
  HASH_PATTERN,
  isNonemptyString,
  isNonnegativeInteger,
  isObject,
  requireClaim,
  TOKEN_PATTERN,
} from "./errors.js";
import { canonicalize } from "./jcs.js";
import { decodeCompact, sha256, signCompact, verifyCompactSignature } from "./jws.js";
import { evidenceKeyId, loadEvidencePrivateKey } from "./keys.js";
import type {
  ActionClass,
  DenialReason,
  DigestCanonicalization,
  DigestScope,
  EvidenceLevel,
  Sensitivity,
  SideEffectClass,
  Verdict,
} from "./tables.js";
import {
  isActionClass,
  isDenialReason,
  isDigestCanonicalization,
  isDigestScope,
  isEvidenceLevel,
  isSensitivity,
  isSideEffectClass,
  isVerdict,
  RECEIPT_OPTIONAL_CLAIMS,
  RECEIPT_REQUIRED_CLAIMS,
} from "./tables.js";

export interface EvidenceDigest {
  alg: "sha-256";
  canonicalization: DigestCanonicalization;
  scope: DigestScope;
  value: string;
}
export interface PolicyDecision {
  backend: string;
  decision: string;
  reason?: string | null;
  rule_id?: string;
  eval_ms?: number;
}
export interface ReceiptClaims {
  schema_version: "ardur.execution_receipt.v0.2";
  canonicalization: "jcs-rfc8785";
  receipt_kind: "action";
  receipt_id: string;
  grant_id: string;
  parent_receipt_hash: string | null;
  parent_receipt_id: string | null;
  actor: string;
  verifier_id: string;
  step_id: string;
  tool: string;
  action_class: ActionClass;
  target: string;
  resource_family: string;
  side_effect_class: SideEffectClass;
  verdict: Verdict;
  evidence_level: EvidenceLevel;
  reason: string;
  policy_decisions: PolicyDecision[];
  arguments_hash: string;
  trace_id: string;
  run_nonce: string;
  invocation_digest: EvidenceDigest;
  budget_remaining: Record<string, number>;
  timestamp: string;
  iss: string;
  iat: number;
  exp: number;
  jti: string;
  content_class?: unknown;
  content_provenance?: unknown;
  sensitivity?: Sensitivity;
  instruction_bearing?: boolean;
  budget_delta?: unknown;
  result_hash?: EvidenceDigest;
  public_denial_reason?: DenialReason;
  internal_denial_code?: string;
  evidence_proof_ref?: unknown;
  measurements?: unknown;
}

export function validateDigest(value: unknown, claim: string): asserts value is EvidenceDigest {
  requireClaim(isObject(value), claim);
  requireClaim(
    Object.keys(value).length === 4 &&
      Object.keys(value).every((key) =>
        ["alg", "canonicalization", "scope", "value"].includes(key),
      ),
    claim,
  );
  requireClaim(
    value.alg === "sha-256" &&
      isDigestCanonicalization(value.canonicalization) &&
      isDigestScope(value.scope) &&
      typeof value.value === "string" &&
      BASE64URL_PATTERN.test(value.value),
    claim,
  );
}

export function validateReceiptClaims(value: unknown): asserts value is ReceiptClaims {
  requireClaim(isObject(value), "claims");
  for (const claim of RECEIPT_REQUIRED_CLAIMS) {
    if (!Object.hasOwn(value, claim))
      throw new EvidenceFormatError("missing_claim", claim, "Required claim");
  }
  const allowed: readonly string[] = [...RECEIPT_REQUIRED_CLAIMS, ...RECEIPT_OPTIONAL_CLAIMS];
  requireClaim(Object.getOwnPropertySymbols(value).length === 0, "claims");
  for (const claim of Object.getOwnPropertyNames(value)) {
    if (!allowed.includes(claim))
      throw new EvidenceFormatError("unknown_claim", claim, "Unknown claim");
    const descriptor = Object.getOwnPropertyDescriptor(value, claim);
    requireClaim(
      descriptor?.enumerable && "value" in descriptor,
      claim,
      "Expected an enumerable data claim",
    );
    try {
      canonicalize(descriptor.value);
    } catch {
      throw new EvidenceFormatError("invalid_claim", claim, "Not canonicalizable JSON");
    }
  }
  const fixed = {
    schema_version: "ardur.execution_receipt.v0.2",
    canonicalization: "jcs-rfc8785",
    receipt_kind: "action",
  };
  for (const [claim, expected] of Object.entries(fixed))
    requireClaim(value[claim] === expected, claim);
  for (const claim of [
    "receipt_id",
    "grant_id",
    "actor",
    "verifier_id",
    "trace_id",
    "run_nonce",
    "step_id",
    "tool",
    "target",
    "resource_family",
    "reason",
    "iss",
    "jti",
  ])
    requireClaim(isNonemptyString(value[claim]), claim);
  requireClaim(
    typeof value.run_nonce === "string" &&
      value.run_nonce.length >= 16 &&
      BASE64URL_PATTERN.test(value.run_nonce),
    "run_nonce",
  );
  requireClaim(
    value.parent_receipt_hash === null ||
      (typeof value.parent_receipt_hash === "string" &&
        HASH_PATTERN.test(value.parent_receipt_hash)),
    "parent_receipt_hash",
  );
  requireClaim(
    value.parent_receipt_hash === null
      ? value.parent_receipt_id === null
      : value.parent_receipt_id === (value.parent_receipt_hash as string).slice(0, 16),
    "parent_receipt_id",
  );
  const guards = {
    action_class: isActionClass,
    side_effect_class: isSideEffectClass,
    verdict: isVerdict,
    evidence_level: isEvidenceLevel,
  };
  for (const [claim, guard] of Object.entries(guards)) requireClaim(guard(value[claim]), claim);
  validateDigest(value.invocation_digest, "invocation_digest");
  requireClaim(
    value.invocation_digest.canonicalization === "jcs-rfc8785" &&
      value.invocation_digest.scope === "normalized_input",
    "invocation_digest",
  );
  requireClaim(
    typeof value.arguments_hash === "string" && HASH_PATTERN.test(value.arguments_hash),
    "arguments_hash",
  );
  if (Object.hasOwn(value, "result_hash")) validateDigest(value.result_hash, "result_hash");
  requireClaim(isNonnegativeInteger(value.iat) && value.iat <= 253402300799, "iat");
  requireClaim(isNonnegativeInteger(value.exp) && value.exp === value.iat + 3600, "exp");
  requireClaim(
    value.timestamp === new Date(value.iat * 1000).toISOString().replace(".000Z", "Z"),
    "timestamp",
  );
  requireClaim(value.jti === value.receipt_id, "jti");
  requireClaim(value.iss === value.verifier_id, "iss");
  requireClaim(Array.isArray(value.policy_decisions), "policy_decisions");
  for (const [index, decision] of value.policy_decisions.entries()) {
    const claim = `policy_decisions[${index}]`;
    requireClaim(
      isObject(decision) &&
        Object.keys(decision).includes("backend") &&
        Object.keys(decision).includes("decision") &&
        Object.keys(decision).every((key) =>
          ["backend", "decision", "reason", "rule_id", "eval_ms"].includes(key),
        ),
      claim,
    );
    requireClaim(isNonemptyString(decision.backend), `${claim}.backend`);
    requireClaim(isNonemptyString(decision.decision), `${claim}.decision`);
    if (Object.hasOwn(decision, "reason"))
      requireClaim(
        decision.reason === null || typeof decision.reason === "string",
        `${claim}.reason`,
      );
    if (Object.hasOwn(decision, "rule_id"))
      requireClaim(
        typeof decision.rule_id === "string" &&
          Array.from(decision.rule_id).length <= 256 &&
          !/[\p{C}\p{Z}]/u.test(decision.rule_id.replaceAll(" ", "")),
        `${claim}.rule_id`,
      );
    if (Object.hasOwn(decision, "eval_ms"))
      requireClaim(
        typeof decision.eval_ms === "number" &&
          Number.isFinite(decision.eval_ms) &&
          decision.eval_ms >= 0,
        `${claim}.eval_ms`,
      );
  }
  requireClaim(isObject(value.budget_remaining), "budget_remaining");
  for (const [key, remaining] of Object.entries(value.budget_remaining))
    requireClaim(
      TOKEN_PATTERN.test(key) && isNonnegativeInteger(remaining),
      `budget_remaining.${key}`,
    );
  if (value.verdict === "compliant") {
    for (const claim of ["public_denial_reason", "internal_denial_code"])
      requireClaim(!Object.hasOwn(value, claim), claim, "Must be absent for compliant records");
  } else {
    requireClaim(isDenialReason(value.public_denial_reason), "public_denial_reason");
    requireClaim(
      typeof value.internal_denial_code === "string" &&
        TOKEN_PATTERN.test(value.internal_denial_code),
      "internal_denial_code",
    );
  }
  if (Object.hasOwn(value, "sensitivity"))
    requireClaim(isSensitivity(value.sensitivity), "sensitivity");
  if (Object.hasOwn(value, "instruction_bearing"))
    requireClaim(typeof value.instruction_bearing === "boolean", "instruction_bearing");
}

export type ReceiptInput = {
  runId: string;
  spaceId: string;
  botId?: string;
  actor?: string;
  verifierId?: string;
  grantId: string;
  traceId: string;
  runNonce: string;
  step: number;
  tool: string;
  args: unknown;
  actionClass: ActionClass;
  sideEffectClass: SideEffectClass;
  target: string;
  resourceFamily: string;
  verdict: Verdict;
  reason: string;
  policyDecisions: PolicyDecision[];
  budgetRemaining: Record<string, number>;
  now?: Date | (() => Date);
} & Pick<ReceiptClaims, (typeof RECEIPT_OPTIONAL_CLAIMS)[number]>;

export function buildReceiptClaims(input: ReceiptInput, previous: string | null): ReceiptClaims {
  requireClaim(isNonemptyString(input.runId), "runId");
  requireClaim(isNonemptyString(input.spaceId), "spaceId");
  requireClaim(isNonnegativeInteger(input.step), "step");
  const iat = epochSeconds(input.now);
  const receiptId = randomUUID();
  const parentHash = previous === null ? null : sha256(previous);
  const verifierId = input.verifierId ?? `ardur:${input.spaceId}:evidence`;
  const claims: ReceiptClaims = {
    schema_version: "ardur.execution_receipt.v0.2",
    canonicalization: "jcs-rfc8785",
    receipt_kind: "action",
    receipt_id: receiptId,
    grant_id: input.grantId,
    parent_receipt_hash: parentHash,
    parent_receipt_id: parentHash?.slice(0, 16) ?? null,
    actor: input.actor ?? input.botId ?? "",
    verifier_id: verifierId,
    step_id: `${input.runId}:${input.step}`,
    tool: input.tool,
    action_class: input.actionClass,
    side_effect_class: input.sideEffectClass,
    target: input.target,
    resource_family: input.resourceFamily,
    verdict: input.verdict,
    evidence_level: "self_signed",
    reason: input.reason,
    policy_decisions: input.policyDecisions,
    arguments_hash: sha256(canonicalize(input.args)),
    trace_id: input.traceId,
    run_nonce: input.runNonce,
    invocation_digest: {
      alg: "sha-256",
      canonicalization: "jcs-rfc8785",
      scope: "normalized_input",
      value: createHash("sha256")
        .update(canonicalize({ tool: input.tool, args: input.args }))
        .digest("base64url"),
    },
    budget_remaining: input.budgetRemaining,
    timestamp: new Date(iat * 1000).toISOString().replace(".000Z", "Z"),
    iss: verifierId,
    iat,
    exp: iat + 3600,
    jti: receiptId,
  };
  const optional = Object.fromEntries(
    RECEIPT_OPTIONAL_CLAIMS.filter((key) => Object.hasOwn(input, key)).map((key) => [
      key,
      input[key],
    ]),
  );
  Object.assign(claims, optional);
  validateReceiptClaims(claims);
  return claims;
}

export function signReceipt(
  claims: ReceiptClaims,
  privateKey: KeyObject | string,
  kid: string,
): string {
  validateReceiptClaims(claims);
  requireClaim(
    claims.evidence_level === "self_signed",
    "evidence_level",
    "Only self_signed records can be emitted",
  );
  return signCompact(claims, privateKey, kid, "application/ardur.er+jwt");
}

export interface ChainRecord {
  jws: string;
  receiptId: string;
  sha256: string;
  parentSha256: string | null;
  seq: number;
}
export interface EvidenceChain {
  readonly previousJws: string | null;
  readonly nextStep: number;
  append(input: Omit<ReceiptInput, "step">): ChainRecord;
}

function chain(
  privateKey: KeyObject | string,
  kid: string,
  previous: string | null,
  nextStep: number,
): EvidenceChain {
  const key = typeof privateKey === "string" ? loadEvidencePrivateKey(privateKey) : privateKey;
  return {
    get previousJws() {
      return previous;
    },
    get nextStep() {
      return nextStep;
    },
    append(input) {
      const claims = buildReceiptClaims({ ...input, step: nextStep }, previous);
      const jws = signReceipt(claims, key, kid);
      const record = {
        jws,
        receiptId: claims.receipt_id,
        sha256: sha256(jws),
        parentSha256: claims.parent_receipt_hash,
        seq: nextStep,
      };
      previous = jws;
      nextStep++;
      return record;
    },
  };
}

export function createEvidenceChain(privateKey: KeyObject | string, kid: string): EvidenceChain {
  return chain(privateKey, kid, null, 0);
}

/** The stored tail and sequence must come from the same durable append. */
export function resumeChain(
  { lastJws, lastSeq }: { lastJws: string; lastSeq: number },
  privateKey: KeyObject | string,
  kid: string,
): EvidenceChain {
  if (!isNonnegativeInteger(lastSeq) || lastSeq === Number.MAX_SAFE_INTEGER)
    throw new EvidenceFormatError("invalid_sequence", "lastSeq", "Expected a resumable sequence");
  try {
    const decoded = decodeCompact(lastJws);
    validateReceiptClaims(decoded.payload);
    const key = createPublicKey(
      typeof privateKey === "string" ? loadEvidencePrivateKey(privateKey) : privateKey,
    );
    const header = decoded.header;
    requireClaim(
      isObject(header) &&
        header.alg === "ES256" &&
        header.typ === "application/ardur.er+jwt" &&
        header.kid === kid &&
        evidenceKeyId(key) === kid &&
        Object.keys(header).length === 3,
      "header",
    );
    requireClaim(verifyCompactSignature(decoded, key), "signature");
    requireClaim(
      Buffer.from(canonicalize(decoded.payload)).equals(decoded.payloadBytes),
      "payload",
    );
    requireClaim(decoded.payload.step_id.endsWith(`:${lastSeq}`), "lastSeq");
  } catch {
    throw new EvidenceFormatError(
      "invalid_jws",
      "lastJws",
      "Stored tail is invalid or does not match the key and sequence",
    );
  }
  return chain(privateKey, kid, lastJws, lastSeq + 1);
}
