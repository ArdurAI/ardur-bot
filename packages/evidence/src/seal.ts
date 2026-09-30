import type { KeyObject } from "node:crypto";
import { createPublicKey, randomUUID } from "node:crypto";
import { EvidenceFormatError, epochSeconds, requireClaim } from "./errors.js";
import { decodeCompact, sha256, signCompact } from "./jws.js";
import { loadEvidencePrivateKey } from "./keys.js";
import type { ReceiptClaims } from "./receipt.js";
import { SEAL_LIFETIME_SECONDS } from "./tables.js";
import type { SealClaims } from "./verify.js";
import { validateSealClaims, verifyChain } from "./verify.js";

export interface SealRunInput {
  records: readonly string[];
  actor: string;
  grantId: string;
  iss: string;
  now?: Date | (() => Date);
}

export function sealRun(
  { records, actor, grantId, iss, now }: SealRunInput,
  privateKey: KeyObject | string,
  kid: string,
): string {
  if (!Array.isArray(records) || records.length === 0)
    throw new EvidenceFormatError("empty_chain", "records", "Cannot seal a run with no records");
  const key = typeof privateKey === "string" ? loadEvidencePrivateKey(privateKey) : privateKey;
  requireClaim(
    verifyChain(records, createPublicKey(key)).ok,
    "records",
    "Cannot seal an invalid chain",
  );
  const claims = records.map((jws) => decodeCompact(jws).payload as ReceiptClaims);
  requireClaim(
    claims.every(
      (receipt) => receipt.actor === actor && receipt.grant_id === grantId && receipt.iss === iss,
    ),
    "records",
    "Run identity does not match its receipts",
  );
  const last = claims[claims.length - 1];
  const lastJws = records[records.length - 1];
  requireClaim(last && lastJws, "records");
  const iat = epochSeconds(now);
  const permits = claims.filter((receipt) => receipt.verdict === "compliant").length;
  const seal: SealClaims = {
    schema_version: "ardur.behavioral_attestation.v0.2",
    type: "behavioral_attestation",
    iss,
    sub: actor,
    aud: "vibap-attestation-verifier",
    iat,
    exp: iat + SEAL_LIFETIME_SECONDS,
    jti: randomUUID(),
    passport_jti: grantId,
    receipt_chain_head: {
      hash_algorithm: "sha-256",
      receipt_id: last.receipt_id,
      receipt_jwt_sha256: sha256(lastJws),
    },
    total_events: claims.length,
    permits,
    denials: claims.length - permits,
  };
  validateSealClaims(seal);
  return signCompact(seal, key, kid, "JWT");
}
