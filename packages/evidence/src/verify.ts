import type { KeyObject } from "node:crypto";
import {
  HASH_PATTERN,
  isNonemptyString,
  isNonnegativeInteger,
  isObject,
  requireClaim,
} from "./errors.js";
import { canonicalize } from "./jcs.js";
import { decodeCompact, sha256, verifyCompactSignature } from "./jws.js";
import { evidenceKeyId, loadEvidencePublicKey } from "./keys.js";
import type { ReceiptClaims } from "./receipt.js";
import { validateReceiptClaims } from "./receipt.js";
import type { VerificationCode } from "./tables.js";
import { SEAL_LIFETIME_SECONDS, SEAL_REQUIRED_CLAIMS } from "./tables.js";

export interface VerificationFailure {
  index: number;
  code: VerificationCode;
  message: string;
}
export interface VerificationResult {
  ok: boolean;
  recordCount: number;
  headReceiptId: string | null;
  failures: VerificationFailure[];
}
export interface SealClaims {
  schema_version: "ardur.behavioral_attestation.v0.2";
  type: "behavioral_attestation";
  iss: string;
  sub: string;
  aud: "vibap-attestation-verifier";
  iat: number;
  exp: number;
  jti: string;
  passport_jti: string;
  receipt_chain_head: { hash_algorithm: "sha-256"; receipt_id: string; receipt_jwt_sha256: string };
  total_events: number;
  permits: number;
  denials: number;
}

export function validateSealClaims(value: unknown): asserts value is SealClaims {
  requireClaim(isObject(value), "seal");
  requireClaim(
    Object.keys(value).length === SEAL_REQUIRED_CLAIMS.length &&
      SEAL_REQUIRED_CLAIMS.every((claim) => Object.hasOwn(value, claim)),
    "seal",
  );
  requireClaim(value.schema_version === "ardur.behavioral_attestation.v0.2", "schema_version");
  requireClaim(value.type === "behavioral_attestation", "type");
  requireClaim(value.aud === "vibap-attestation-verifier", "aud");
  for (const claim of ["iss", "sub", "jti", "passport_jti"])
    requireClaim(isNonemptyString(value[claim]), claim);
  requireClaim(isNonnegativeInteger(value.iat), "iat");
  requireClaim(
    isNonnegativeInteger(value.exp) && value.exp === value.iat + SEAL_LIFETIME_SECONDS,
    "exp",
  );
  for (const claim of ["total_events", "permits", "denials"])
    requireClaim(isNonnegativeInteger(value[claim]), claim);
  requireClaim(
    (value.permits as number) + (value.denials as number) === value.total_events,
    "total_events",
  );
  const head = value.receipt_chain_head;
  requireClaim(
    isObject(head) &&
      Object.keys(head).length === 3 &&
      head.hash_algorithm === "sha-256" &&
      isNonemptyString(head.receipt_id) &&
      typeof head.receipt_jwt_sha256 === "string" &&
      HASH_PATTERN.test(head.receipt_jwt_sha256),
    "receipt_chain_head",
  );
  canonicalize(value);
}

function inspect(
  jws: unknown,
  key: KeyObject | string,
  typ: string,
  index: number,
  failures: VerificationFailure[],
): ReturnType<typeof decodeCompact> | null {
  const fail = (code: VerificationCode, message: string) => failures.push({ index, code, message });
  let decoded: ReturnType<typeof decodeCompact>;
  try {
    decoded = decodeCompact(jws);
  } catch {
    fail("malformed_jws", "Expected a compact JWS with valid JSON and unpadded base64url");
    return null;
  }
  const header = decoded.header;
  if (
    !isObject(header) ||
    header.alg !== "ES256" ||
    header.typ !== typ ||
    typeof header.kid !== "string" ||
    Object.keys(header).length !== 3
  ) {
    fail("header_invalid", "Expected the ES256 protected header");
    return null;
  }
  if (Buffer.from(canonicalize(header)).toString("base64url") !== decoded.data.split(".")[0]) {
    fail("header_invalid", "Protected header is not canonical");
    return null;
  }
  const seal = typ === "JWT";
  try {
    if (header.kid !== evidenceKeyId(key)) {
      fail(
        seal ? "seal_signature_invalid" : "kid_mismatch",
        "Key ID does not match the supplied public key",
      );
      return null;
    }
    if (!verifyCompactSignature(decoded, key)) {
      fail(seal ? "seal_signature_invalid" : "signature_invalid", "Signature verification failed");
      return null;
    }
  } catch {
    fail(
      seal ? "seal_signature_invalid" : "signature_invalid",
      "Invalid verification key or signature",
    );
    return null;
  }
  try {
    if (!Buffer.from(canonicalize(decoded.payload)).equals(decoded.payloadBytes)) {
      fail("payload_not_canonical", "Payload bytes are not canonical JSON");
      return null;
    }
  } catch {
    fail("payload_not_canonical", "Payload is not canonicalizable JSON");
    return null;
  }
  return decoded;
}

function verificationKey(publicKey: KeyObject | string): KeyObject {
  const key = typeof publicKey === "string" ? loadEvidencePublicKey(publicKey) : publicKey;
  evidenceKeyId(key);
  return key;
}

export function verifyChain(
  jwsList: readonly string[],
  publicKey: KeyObject | string,
): VerificationResult {
  const failures: VerificationFailure[] = [];
  const result: VerificationResult = {
    ok: false,
    recordCount: Array.isArray(jwsList) ? jwsList.length : 0,
    headReceiptId: null,
    failures,
  };
  if (!Array.isArray(jwsList)) {
    failures.push({ index: -1, code: "malformed_jws", message: "Expected a list of records" });
    return result;
  }
  let key: KeyObject;
  try {
    key = verificationKey(publicKey);
  } catch {
    failures.push({
      index: -1,
      code: "signature_invalid",
      message: "Expected an EC P-256 public key",
    });
    return result;
  }
  let firstClaims: ReceiptClaims | null = null;
  let runId: string | null = null;
  for (let index = 0; index < jwsList.length; index++) {
    let decoded: ReturnType<typeof decodeCompact> | null;
    try {
      decoded = inspect(jwsList[index], key, "application/ardur.er+jwt", index, failures);
    } catch {
      failures.push({ index, code: "header_invalid", message: "Invalid protected header" });
      continue;
    }
    if (!decoded) continue;
    const previous = index === 0 ? null : jwsList[index - 1];
    const parentHash = typeof previous === "string" ? sha256(previous) : null;
    if (
      isObject(decoded.payload) &&
      (decoded.payload.parent_receipt_hash !== parentHash ||
        decoded.payload.parent_receipt_id !== (parentHash?.slice(0, 16) ?? null))
    ) {
      failures.push({
        index,
        code: "chain_broken",
        message: "Parent does not match the previous compact record",
      });
    }
    try {
      validateReceiptClaims(decoded.payload);
    } catch {
      failures.push({
        index,
        code: "claims_invalid",
        message: "Receipt claims do not match the format",
      });
      continue;
    }
    const claims = decoded.payload;
    if (index === 0) {
      firstClaims = claims;
      runId = claims.step_id.slice(0, claims.step_id.lastIndexOf(":"));
    }
    const identity = firstClaims;
    if (
      identity &&
      (!isNonemptyString(runId) ||
        claims.step_id !== `${runId}:${index}` ||
        (["grant_id", "trace_id", "run_nonce", "actor", "verifier_id", "iss"] as const).some(
          (claim) => claims[claim] !== identity[claim],
        ))
    ) {
      failures.push({
        index,
        code: "run_mismatch",
        message: "Receipt identity or step does not match the first record's run",
      });
    }
    if (index === jwsList.length - 1) result.headReceiptId = claims.receipt_id;
  }
  result.ok = failures.length === 0;
  return result;
}

export function verifySeal(
  sealJwt: string,
  jwsList: readonly string[],
  publicKey: KeyObject | string,
): VerificationResult {
  const result = verifyChain(jwsList, publicKey);
  const index = result.recordCount;
  const fail = (code: VerificationCode, message: string) => {
    result.failures.push({ index, code, message });
    result.ok = false;
  };
  let decoded: ReturnType<typeof decodeCompact> | null;
  try {
    decoded = inspect(sealJwt, verificationKey(publicKey), "JWT", index, result.failures);
  } catch {
    fail("seal_signature_invalid", "Invalid seal or verification key");
    return result;
  }
  if (!decoded) {
    result.ok = false;
    return result;
  }
  if (
    !isObject(decoded.payload) ||
    !Object.hasOwn(decoded.payload, "receipt_chain_head") ||
    decoded.payload.receipt_chain_head === null
  ) {
    fail("seal_missing_chain_head", "Seal has no receipt chain head");
    return result;
  }
  try {
    validateSealClaims(decoded.payload);
  } catch {
    fail("seal_claims_invalid", "Seal claims do not match the format");
    return result;
  }
  const seal = decoded.payload;
  if (!Array.isArray(jwsList) || jwsList.length === 0) {
    fail("receipt_chain_head_mismatch", "A seal requires at least one record");
    return result;
  }
  const lastJws = jwsList[jwsList.length - 1];
  if (
    typeof lastJws !== "string" ||
    seal.receipt_chain_head.receipt_jwt_sha256 !== sha256(lastJws) ||
    seal.receipt_chain_head.receipt_id !== result.headReceiptId
  ) {
    fail("receipt_chain_head_mismatch", "Seal does not name the supplied chain tail");
  }
  if (result.failures.length > 0) return result;
  // Every record has already passed validation and signature checking.
  const receipts = jwsList.map((jws) => decodeCompact(jws).payload as ReceiptClaims);
  const permits = receipts.filter((receipt) => receipt.verdict === "compliant").length;
  if (
    seal.total_events !== receipts.length ||
    seal.permits !== permits ||
    seal.denials !== receipts.length - permits ||
    receipts.some(
      (receipt) =>
        receipt.actor !== seal.sub ||
        receipt.grant_id !== seal.passport_jti ||
        receipt.iss !== seal.iss,
    )
  ) {
    fail("seal_claims_invalid", "Seal identity or counts do not match the records");
  }
  result.ok = result.failures.length === 0;
  return result;
}
