import { describe, expect, it } from "vitest";
import { EvidenceFormatError } from "./errors.js";
import { canonicalize } from "./jcs.js";
import { decodeCompact, sha256 } from "./jws.js";
import { generateEvidenceKey } from "./keys.js";
import { createEvidenceChain } from "./receipt.js";
import { sealRun } from "./seal.js";
import { SEAL_LIFETIME_SECONDS, SEAL_REQUIRED_CLAIMS } from "./tables.js";
import { receiptInput } from "./test-input.js";
import { validateSealClaims } from "./verify.js";

const keys = generateEvidenceKey();
function sample() {
  const chain = createEvidenceChain(keys.privateKeyPem, keys.kid);
  return [
    chain.append(receiptInput()).jws,
    chain.append(
      receiptInput({
        verdict: "unknown",
        public_denial_reason: "unknown",
        internal_denial_code: "unknown",
      }),
    ).jws,
  ];
}
const options = {
  actor: "bot-test",
  grantId: "grant-test",
  iss: "ardur:space-test:evidence",
  now: receiptInput().now,
};

describe("sealRun", () => {
  it("builds the exact JWT and run totals", () => {
    const records = sample();
    const seal = sealRun({ ...options, records }, keys.privateKeyPem, keys.kid);
    const decoded = decodeCompact(seal);
    expect(decoded.header).toEqual({ alg: "ES256", kid: keys.kid, typ: "JWT" });
    expect(decoded.payloadBytes.toString()).toBe(canonicalize(decoded.payload));
    const last = decodeCompact(records[1]).payload as { receipt_id: string };
    expect(decoded.payload).toMatchObject({
      schema_version: "ardur.behavioral_attestation.v0.2",
      type: "behavioral_attestation",
      iss: options.iss,
      sub: options.actor,
      passport_jti: options.grantId,
      aud: "vibap-attestation-verifier",
      total_events: 2,
      permits: 1,
      denials: 1,
      receipt_chain_head: {
        hash_algorithm: "sha-256",
        receipt_id: last.receipt_id,
        receipt_jwt_sha256: sha256(records[1] ?? ""),
      },
    });
    const times = decoded.payload as { iat: number; exp: number };
    expect(times.exp - times.iat).toBe(SEAL_LIFETIME_SECONDS);
  });
  it("refuses an empty chain with a typed error", () => {
    expect(() => sealRun({ ...options, records: [] }, keys.privateKeyPem, keys.kid)).toThrow(
      expect.objectContaining({ code: "empty_chain", claim: "records" }),
    );
  });
  it("refuses corrupt chains and mismatched run identity", () => {
    expect(() => sealRun({ ...options, records: ["bad"] }, keys.privateKeyPem, keys.kid)).toThrow(
      EvidenceFormatError,
    );
    for (const patch of [{ actor: "other" }, { grantId: "other" }, { iss: "other" }])
      expect(() =>
        sealRun({ ...options, ...patch, records: sample() }, keys.privateKeyPem, keys.kid),
      ).toThrow(EvidenceFormatError);
  });
  it.each(SEAL_REQUIRED_CLAIMS)("requires seal claim %s", (claim) => {
    const seal = sealRun({ ...options, records: sample() }, keys.privateKeyPem, keys.kid);
    const claims = decodeCompact(seal).payload as Record<string, unknown>;
    delete claims[claim];
    expect(() => validateSealClaims(claims)).toThrow(EvidenceFormatError);
  });
});
