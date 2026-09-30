import { sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./jcs.js";
import { decodeCompact, sha256, signCompact } from "./jws.js";
import { generateEvidenceKey, loadEvidencePrivateKey } from "./keys.js";
import { buildReceiptClaims, createEvidenceChain } from "./receipt.js";
import { sealRun } from "./seal.js";
import type { VerificationCode } from "./tables.js";
import { receiptInput } from "./test-input.js";
import { verifyChain, verifySeal } from "./verify.js";

const keys = generateEvidenceKey();
const privateKey = loadEvidencePrivateKey(keys.privateKeyPem);
function run() {
  const chain = createEvidenceChain(privateKey, keys.kid);
  const records = [
    chain.append(receiptInput()),
    chain.append(receiptInput()),
    chain.append(
      receiptInput({
        verdict: "violation",
        public_denial_reason: "policy_denied",
        internal_denial_code: "rule.send",
      }),
    ),
    chain.append(receiptInput()),
  ].map((record) => record.jws);
  const seal = sealRun(
    {
      records,
      actor: "bot-test",
      grantId: "grant-test",
      iss: "ardur:space-test:evidence",
      now: receiptInput().now,
    },
    privateKey,
    keys.kid,
  );
  return { chain, records, seal };
}
function hasCode(result: ReturnType<typeof verifyChain>, code: VerificationCode) {
  expect(result.ok).toBe(false);
  expect(result.failures.map((failure) => failure.code)).toContain(code);
}
function signedPayload(payload: unknown, typ = "application/ardur.er+jwt") {
  return signCompact(payload, privateKey, keys.kid, typ);
}

describe("chain and seal verification", () => {
  it("rejects an empty chain with a stable list-level failure", () => {
    expect(verifyChain([], keys.publicKeyPem)).toEqual({
      ok: false,
      recordCount: 0,
      headReceiptId: null,
      failures: [expect.objectContaining({ index: -1, code: "empty_chain" })],
    });
  });
  it("keeps empty sealed journals invalid", () => {
    const { seal } = run();
    const result = verifySeal(seal, [], keys.publicKeyPem);
    expect(result.ok).toBe(false);
    expect(result.recordCount).toBe(0);
    expect(result.headReceiptId).toBeNull();
    expect(result.failures).toEqual([
      expect.objectContaining({ index: -1, code: "empty_chain" }),
      expect.objectContaining({ index: 0, code: "receipt_chain_head_mismatch" }),
    ]);
  });
  it("accepts the full sealed run", () => {
    const { records, seal } = run();
    const last = decodeCompact(records[3]).payload as { receipt_id: string };
    expect(verifyChain(records, keys.publicKeyPem)).toEqual({
      ok: true,
      recordCount: 4,
      headReceiptId: last.receipt_id,
      failures: [],
    });
    expect(verifySeal(seal, records, keys.publicKeyPem).ok).toBe(true);
  });
  it.each([
    ["runId", { runId: "run-other" }],
    ["grant_id", { grantId: "grant-other" }],
    ["trace_id", { traceId: "trace-other" }],
    ["run_nonce", { runNonce: "YWJjZGVmMDEyMzQ1Njc4OQ" }],
    ["actor", { actor: "actor-other" }],
    ["verifier_id and iss", { verifierId: "verifier-other" }],
    ["verifier_id and iss default", { spaceId: "space-other" }],
  ] as const)("rejects a linked same-key record differing in %s", (_field, overrides) => {
    const first = signedPayload(buildReceiptClaims(receiptInput(), null));
    const foreign = buildReceiptClaims(receiptInput({ ...overrides, step: 1 }), first);
    const result = verifyChain([first, signedPayload(foreign)], keys.publicKeyPem);
    expect(foreign.parent_receipt_hash).toBe(sha256(first));
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([expect.objectContaining({ index: 1, code: "run_mismatch" })]);
  });
  it.each(["run-test:0", "run-test:2", "run-test:01", "run-other:1", "invalid"])(
    "rejects a correctly linked second record with step_id %s",
    (step_id) => {
      const first = signedPayload(buildReceiptClaims(receiptInput(), null));
      const second = buildReceiptClaims(receiptInput({ step: 1 }), first);
      const result = verifyChain([first, signedPayload({ ...second, step_id })], keys.publicKeyPem);
      expect(result.ok).toBe(false);
      expect(result.failures).toEqual([
        expect.objectContaining({ index: 1, code: "run_mismatch" }),
      ]);
    },
  );
  it.each(["run-test:1", "run-test:00", "invalid", ":0", " :0"])(
    "rejects an invalid first step_id %s",
    (step_id) => {
      const first = signedPayload({ ...buildReceiptClaims(receiptInput(), null), step_id });
      const result = verifyChain([first], keys.publicKeyPem);
      expect(result.ok).toBe(false);
      expect(result.failures).toEqual([
        expect.objectContaining({ index: 0, code: "run_mismatch" }),
      ]);
    },
  );
  it("accepts exact steps when the run ID contains colons", () => {
    const chain = createEvidenceChain(privateKey, keys.kid);
    const input = receiptInput({ runId: "run:with:colons" });
    const records = [chain.append(input).jws, chain.append(input).jws];
    expect(verifyChain(records, keys.publicKeyPem).ok).toBe(true);
  });
  it("rejects an edit retaining the old signature", () => {
    const { records } = run();
    const parts = (records[1] ?? "").split(".");
    const claims = decodeCompact(records[1]).payload as Record<string, unknown>;
    parts[1] = Buffer.from(canonicalize({ ...claims, target: "edited.txt" })).toString("base64url");
    records[1] = parts.join(".");
    hasCode(verifyChain(records, keys.publicKeyPem), "signature_invalid");
  });
  it("rejects a removed middle record", () => {
    const { records } = run();
    records.splice(1, 1);
    hasCode(verifyChain(records, keys.publicKeyPem), "chain_broken");
  });
  it("detects tail truncation only with a seal", () => {
    const { records, seal } = run();
    records.pop();
    expect(verifyChain(records, keys.publicKeyPem).ok).toBe(true);
    hasCode(verifySeal(seal, records, keys.publicKeyPem), "receipt_chain_head_mismatch");
  });
  it("rejects extra records after sealing", () => {
    const { records, seal, chain } = run();
    records.push(chain.append(receiptInput()).jws);
    expect(verifyChain(records, keys.publicKeyPem).ok).toBe(true);
    hasCode(verifySeal(seal, records, keys.publicKeyPem), "receipt_chain_head_mismatch");
  });
  it("rejects another key's record and seal", () => {
    const { records, seal } = run();
    const other = generateEvidenceKey();
    const otherRecord = signCompact(
      buildReceiptClaims(receiptInput(), null),
      other.privateKeyPem,
      other.kid,
      "application/ardur.er+jwt",
    );
    hasCode(verifyChain([otherRecord], keys.publicKeyPem), "kid_mismatch");
    const otherSeal = signCompact(
      decodeCompact(seal).payload,
      other.privateKeyPem,
      other.kid,
      "JWT",
    );
    hasCode(verifySeal(otherSeal, records, keys.publicKeyPem), "seal_signature_invalid");
    hasCode(verifySeal(seal, records, other.publicKeyPem), "seal_signature_invalid");
  });
  it("rejects a forged signature even when kid matches", () => {
    const claims = buildReceiptClaims(receiptInput(), null);
    const parts = signedPayload(claims).split(".");
    const other = generateEvidenceKey();
    parts[2] = sign("sha256", Buffer.from(parts.slice(0, 2).join(".")), {
      key: other.privateKeyPem,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    hasCode(verifyChain([parts.join(".")], keys.publicKeyPem), "signature_invalid");
  });
  it("rejects first-record parents and a wrong parent hash", () => {
    const claims = buildReceiptClaims(receiptInput(), null);
    hasCode(
      verifyChain(
        [
          signedPayload({
            ...claims,
            parent_receipt_hash: "a".repeat(64),
            parent_receipt_id: "a".repeat(16),
          }),
        ],
        keys.publicKeyPem,
      ),
      "chain_broken",
    );
    const first = signedPayload(claims);
    const second = buildReceiptClaims(receiptInput({ step: 1 }), first);
    hasCode(
      verifyChain(
        [
          first,
          signedPayload({
            ...second,
            parent_receipt_hash: "b".repeat(64),
            parent_receipt_id: "b".repeat(16),
          }),
        ],
        keys.publicKeyPem,
      ),
      "chain_broken",
    );
    expect(sha256(first)).not.toBe("b".repeat(64));
  });
  it("rejects a validly signed noncanonical payload", () => {
    const claims = buildReceiptClaims(receiptInput(), null);
    const header = Buffer.from(
      canonicalize({ alg: "ES256", kid: keys.kid, typ: "application/ardur.er+jwt" }),
    ).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims, null, 2)).toString("base64url");
    const data = `${header}.${payload}`;
    const signature = sign("sha256", Buffer.from(data, "ascii"), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    hasCode(verifyChain([`${data}.${signature}`], keys.publicKeyPem), "payload_not_canonical");
  });
  it("rejects signed invalid claims", () => {
    hasCode(
      verifyChain(
        [signedPayload({ ...buildReceiptClaims(receiptInput(), null), tool: "" })],
        keys.publicKeyPem,
      ),
      "claims_invalid",
    );
  });
  it.each([
    "",
    "a.b",
    "a.b.c.d",
    "e30=.e30.AA",
    "e30.e30.A+",
    "e30.e30.A",
    "AA.e30.AA",
    "_w.e30.AA",
  ])("handles malformed JWS %s without throwing", (jws) => {
    hasCode(verifyChain([jws], keys.publicKeyPem), "malformed_jws");
    hasCode(verifySeal(jws, [], keys.publicKeyPem), "malformed_jws");
  });
  it.each([null, undefined, 1, {}, []])(
    "handles bad runtime token input %# without throwing",
    (input) => {
      hasCode(verifyChain([input as string], keys.publicKeyPem), "malformed_jws");
      expect(() => verifySeal(input as string, [], keys.publicKeyPem)).not.toThrow();
    },
  );
  it("handles bad lists and keys without throwing", () => {
    expect(verifyChain(null as unknown as string[], keys.publicKeyPem).ok).toBe(false);
    expect(verifyChain([], "invalid").ok).toBe(false);
    const { records, seal } = run();
    expect(() => verifySeal(seal, null as unknown as string[], keys.publicKeyPem)).not.toThrow();
    expect(verifySeal(seal, records, "invalid").ok).toBe(false);
  });
  it.each([{ alg: "none" }, { typ: "JWT" }, { extra: true }, { kid: 1 }])(
    "rejects invalid headers %#",
    (patch) => {
      const jws = signedPayload(buildReceiptClaims(receiptInput(), null));
      const parts = jws.split(".");
      parts[0] = Buffer.from(
        canonicalize({ alg: "ES256", kid: keys.kid, typ: "application/ardur.er+jwt", ...patch }),
      ).toString("base64url");
      hasCode(verifyChain([parts.join(".")], keys.publicKeyPem), "header_invalid");
    },
  );
  it("rejects noncanonical protected headers and invalid signatures", () => {
    const jws = signedPayload(buildReceiptClaims(receiptInput(), null));
    const parts = jws.split(".");
    parts[0] = Buffer.from(
      JSON.stringify({ typ: "application/ardur.er+jwt", kid: keys.kid, alg: "ES256" }),
    ).toString("base64url");
    hasCode(verifyChain([parts.join(".")], keys.publicKeyPem), "header_invalid");
    const badSignature = jws.split(".");
    badSignature[2] = Buffer.alloc(63).toString("base64url");
    hasCode(verifyChain([badSignature.join(".")], keys.publicKeyPem), "signature_invalid");
  });
  it("rejects a seal with no chain head", () => {
    const { records, seal } = run();
    const claims = decodeCompact(seal).payload as Record<string, unknown>;
    delete claims.receipt_chain_head;
    hasCode(
      verifySeal(signedPayload(claims, "JWT"), records, keys.publicKeyPem),
      "seal_missing_chain_head",
    );
  });
  it("rejects empty sealed chains and incorrect head IDs", () => {
    const { records, seal } = run();
    hasCode(verifySeal(seal, [], keys.publicKeyPem), "receipt_chain_head_mismatch");
    const claims = decodeCompact(seal).payload as Record<string, unknown>;
    hasCode(
      verifySeal(
        signedPayload(
          {
            ...claims,
            receipt_chain_head: { ...(claims.receipt_chain_head as object), receipt_id: "wrong" },
          },
          "JWT",
        ),
        records,
        keys.publicKeyPem,
      ),
      "receipt_chain_head_mismatch",
    );
  });
  it.each([
    { schema_version: "bad" },
    { type: "bad" },
    { iss: "wrong" },
    { sub: "wrong" },
    { aud: "wrong" },
    { iat: -1 },
    { exp: 1 },
    { jti: "" },
    { passport_jti: "wrong" },
    { total_events: -1 },
    { permits: 0 },
    { denials: 0 },
    { total_events: 5, permits: 4, denials: 1 },
    { receipt_chain_head: {} },
    { extra: 1 },
  ])("rejects invalid seal claims %#", (patch) => {
    const { records, seal } = run();
    hasCode(
      verifySeal(
        signedPayload({ ...(decodeCompact(seal).payload as object), ...patch }, "JWT"),
        records,
        keys.publicKeyPem,
      ),
      "seal_claims_invalid",
    );
  });
  it("reports chain_broken for a signed parent ID mismatch", () => {
    const first = signedPayload(buildReceiptClaims(receiptInput(), null));
    const second = buildReceiptClaims(receiptInput({ step: 1 }), first);
    hasCode(
      verifyChain(
        [first, signedPayload({ ...second, parent_receipt_id: "wrong" })],
        keys.publicKeyPem,
      ),
      "chain_broken",
    );
  });
  it("does not expire historical evidence by wall clock", () => {
    const { records, seal } = run();
    expect(verifySeal(seal, records, keys.publicKeyPem).ok).toBe(true);
  });
});
