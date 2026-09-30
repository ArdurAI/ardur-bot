import { createHash, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EvidenceFormatError } from "./errors.js";
import { canonicalize } from "./jcs.js";
import { generateEvidenceKey, loadEvidencePrivateKey } from "./keys.js";
import type { ReceiptClaims } from "./receipt.js";
import {
  buildReceiptClaims,
  createEvidenceChain,
  resumeChain,
  signReceipt,
  validateReceiptClaims,
} from "./receipt.js";
import {
  ACTION_CLASSES,
  DENIAL_REASONS,
  DIGEST_CANONICALIZATIONS,
  DIGEST_SCOPES,
  EVIDENCE_LEVELS,
  RECEIPT_REQUIRED_CLAIMS,
  SENSITIVITIES,
  SIDE_EFFECT_CLASSES,
  VERDICTS,
} from "./tables.js";
import { receiptInput } from "./test-input.js";

const keys = generateEvidenceKey();
const key = loadEvidencePrivateKey(keys.privateKeyPem);
const base = () => buildReceiptClaims(receiptInput(), null);

describe("receipt building and signing", () => {
  it("builds a compliant canonical record without raw args", () => {
    const input = receiptInput();
    const claims = base();
    expect(claims).toMatchObject({
      actor: input.botId,
      grant_id: input.grantId,
      step_id: "run-test:0",
      evidence_level: "self_signed",
      parent_receipt_hash: null,
      parent_receipt_id: null,
      timestamp: "2026-09-29T12:00:00Z",
    });
    expect(claims.jti).toBe(claims.receipt_id);
    expect(claims.iss).toBe(claims.verifier_id);
    expect(claims.exp).toBe(claims.iat + 3600);
    expect(claims.arguments_hash).toBe(
      createHash("sha256").update(canonicalize(input.args)).digest("hex"),
    );
    expect(claims.invocation_digest.value).toBe(
      createHash("sha256")
        .update(canonicalize({ tool: input.tool, args: input.args }))
        .digest("base64url"),
    );
    expect(claims).not.toHaveProperty("args");
    expect(claims).not.toHaveProperty("public_denial_reason");
  });
  it("builds a denied record and passes optional metadata", () => {
    const claims = buildReceiptClaims(
      receiptInput({
        actor: "actor-test",
        verifierId: "verifier-test",
        verdict: "violation",
        public_denial_reason: "policy_denied",
        internal_denial_code: "rule.send-denied",
        sensitivity: "internal",
        instruction_bearing: false,
        result_hash: { alg: "sha-256", canonicalization: "none", scope: "result", value: "YWJj" },
        content_class: "text",
        content_provenance: "tool",
        budget_delta: { calls: -1 },
        measurements: { duration: 1 },
        evidence_proof_ref: "proof-test",
        now: () => new Date("2026-09-29T12:00:00.999Z"),
      }),
      null,
    );
    expect(claims).toMatchObject({
      actor: "actor-test",
      iss: "verifier-test",
      public_denial_reason: "policy_denied",
      internal_denial_code: "rule.send-denied",
      sensitivity: "internal",
      instruction_bearing: false,
      timestamp: "2026-09-29T12:00:00Z",
    });
  });
  it("uses exact protected header and canonical payload bytes with raw ES256", () => {
    const claims = base();
    const jws = signReceipt(claims, key, keys.kid);
    const [header, payload, signature] = jws.split(".") as [string, string, string];
    expect(Buffer.from(header, "base64url").toString()).toBe(
      `{"alg":"ES256","kid":"${keys.kid}","typ":"application/ardur.er+jwt"}`,
    );
    expect(Buffer.from(payload, "base64url").toString()).toBe(canonicalize(claims));
    expect(Buffer.from(signature, "base64url")).toHaveLength(64);
    expect(jws).not.toContain("=");
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`, "ascii"),
        { key: createPublicKey(key), dsaEncoding: "ieee-p1363" },
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
  });
  it("never signs invalid claims, false evidence levels, or mismatched keys", () => {
    expect(() => signReceipt({ ...base(), tool: "" }, key, keys.kid)).toThrow(EvidenceFormatError);
    expect(() =>
      signReceipt({ ...base(), evidence_level: "counter_signed" }, key, keys.kid),
    ).toThrow(EvidenceFormatError);
    expect(() => signReceipt(base(), key, generateEvidenceKey().kid)).toThrow(EvidenceFormatError);
  });
  it.each(["runId", "spaceId", "step"] as const)("rejects bad builder %s", (field) => {
    expect(() =>
      buildReceiptClaims(receiptInput({ [field]: field === "step" ? -1 : "" }), null),
    ).toThrow(EvidenceFormatError);
  });
  it("rejects invalid clocks and absent actor", () => {
    expect(() => buildReceiptClaims(receiptInput({ now: new Date("invalid") }), null)).toThrow(
      EvidenceFormatError,
    );
    expect(() => buildReceiptClaims(receiptInput({ botId: undefined }), null)).toThrow(
      EvidenceFormatError,
    );
  });
});

const badValues: [string, unknown][] = [
  ["schema_version", "v1"],
  ["canonicalization", "json"],
  ["receipt_kind", "other"],
  ...[
    "receipt_id",
    "grant_id",
    "actor",
    "verifier_id",
    "trace_id",
    "step_id",
    "tool",
    "target",
    "resource_family",
    "reason",
    "iss",
    "jti",
  ].map((field): [string, unknown] => [field, ""]),
  ["run_nonce", "short"],
  ["run_nonce", "0123456789012345="],
  ["run_nonce", null],
  ["parent_receipt_hash", "A".repeat(64)],
  ["parent_receipt_hash", "a".repeat(63)],
  ["parent_receipt_id", "abc"],
  ["action_class", "bad"],
  ["side_effect_class", "bad"],
  ["verdict", "bad"],
  ["evidence_level", "bad"],
  ["arguments_hash", "A".repeat(64)],
  ["arguments_hash", null],
  ["iat", -1],
  ["iat", 0.5],
  ["iat", "1"],
  ["iat", 1e21],
  ["exp", -1],
  ["exp", 0.5],
  ["exp", "1"],
  ["exp", 1],
  ["timestamp", "2026-09-29T12:00:00.000Z"],
  ["timestamp", "2026-09-29T12:00:01Z"],
  ["iss", "other"],
  ["jti", "other"],
  ["policy_decisions", {}],
  ["policy_decisions", [null]],
  ["policy_decisions", [{ backend: "x", decision: "permit", extra: 1 }]],
  ["policy_decisions", [{ backend: "", decision: "permit" }]],
  ["policy_decisions", [{ backend: "x", decision: "" }]],
  ["policy_decisions", [{ backend: "x", decision: "permit", reason: 1 }]],
  ["policy_decisions", [{ backend: "x", decision: "permit", rule_id: "a".repeat(257) }]],
  ["policy_decisions", [{ backend: "x", decision: "permit", rule_id: "a\nb" }]],
  ["policy_decisions", [{ backend: "x", decision: "permit", rule_id: 1 }]],
  ["policy_decisions", [{ backend: "x", decision: "permit", eval_ms: -1 }]],
  ["policy_decisions", [{ backend: "x", decision: "permit", eval_ms: Infinity }]],
  ["policy_decisions", [{ backend: "x", decision: "permit", eval_ms: "1" }]],
  ["budget_remaining", []],
  ["budget_remaining", { "bad key": 1 }],
  ["budget_remaining", { calls: -1 }],
  ["budget_remaining", { calls: 0.5 }],
  ["budget_remaining", { calls: "1" }],
  ["public_denial_reason", "policy_denied"],
  ["internal_denial_code", "rule.x"],
  ["sensitivity", "bad"],
  ["instruction_bearing", "false"],
  ["content_class", undefined],
  ["invocation_digest", null],
  ["invocation_digest", { alg: "sha-256" }],
  ["result_hash", null],
];

describe("closed receipt validation", () => {
  it.each(RECEIPT_REQUIRED_CLAIMS)("requires %s", (claim) => {
    const claims: Record<string, unknown> = { ...base() };
    delete claims[claim];
    expect(() => validateReceiptClaims(claims)).toThrow(
      expect.objectContaining({ code: "missing_claim", claim }),
    );
  });
  it.each(badValues)("rejects bad %s (%#)", (claim, value) => {
    expect(() => validateReceiptClaims({ ...base(), [claim]: value })).toThrow(EvidenceFormatError);
  });
  it.each([null, [], new Date(), "claims"])("rejects non-object %#", (value) => {
    expect(() => validateReceiptClaims(value)).toThrow(EvidenceFormatError);
  });
  it("rejects hidden or accessor claims before signing", () => {
    const hidden = base();
    Object.defineProperty(hidden, "tool", { value: "read_file", enumerable: false });
    expect(() => signReceipt(hidden, key, keys.kid)).toThrow(EvidenceFormatError);
    const accessor = base();
    let accessed = false;
    Object.defineProperty(accessor, "tool", {
      enumerable: true,
      get() {
        accessed = true;
        return "read_file";
      },
    });
    expect(() => signReceipt(accessor, key, keys.kid)).toThrow(EvidenceFormatError);
    expect(accessed).toBe(false);
    const hiddenDecision = { decision: "permit" };
    Object.defineProperty(hiddenDecision, "backend", { value: "local", enumerable: false });
    expect(() => validateReceiptClaims({ ...base(), policy_decisions: [hiddenDecision] })).toThrow(
      EvidenceFormatError,
    );
  });
  it("checks printable Unicode rule IDs by character count", () => {
    for (const rule_id of ["a\u200bb", "a\u00a0b", "a\u2028b"]) {
      expect(() =>
        validateReceiptClaims({
          ...base(),
          policy_decisions: [{ backend: "local", decision: "permit", rule_id }],
        }),
      ).toThrow(EvidenceFormatError);
    }
    validateReceiptClaims({
      ...base(),
      policy_decisions: [{ backend: "local", decision: "permit", rule_id: "😀".repeat(256) }],
    });
  });
  it("rejects unknown claims with stable code and name", () => {
    expect(() => validateReceiptClaims({ ...base(), args: {} })).toThrow(
      expect.objectContaining({ code: "unknown_claim", claim: "args" }),
    );
  });
  it.each(["alg", "canonicalization", "scope", "value", "extra"])(
    "rejects invalid digest %s",
    (field) => {
      for (const name of ["invocation_digest", "result_hash"]) {
        expect(() =>
          validateReceiptClaims({
            ...base(),
            [name]: { ...base().invocation_digest, [field]: "bad=" },
          }),
        ).toThrow(EvidenceFormatError);
      }
    },
  );
  it("restricts invocation digest to normalized canonical input", () => {
    for (const patch of [{ scope: "result" }, { canonicalization: "none" }]) {
      expect(() =>
        validateReceiptClaims({
          ...base(),
          invocation_digest: { ...base().invocation_digest, ...patch },
        }),
      ).toThrow(EvidenceFormatError);
    }
  });
  it.each(VERDICTS.filter((verdict) => verdict !== "compliant"))(
    "requires both denial claims for %s",
    (verdict) => {
      expect(() => validateReceiptClaims({ ...base(), verdict })).toThrow(EvidenceFormatError);
      expect(() =>
        validateReceiptClaims({
          ...base(),
          verdict,
          public_denial_reason: "policy_denied",
          internal_denial_code: "bad code",
        }),
      ).toThrow(EvidenceFormatError);
      expect(() =>
        validateReceiptClaims({
          ...base(),
          verdict,
          public_denial_reason: "bad",
          internal_denial_code: "valid",
        }),
      ).toThrow(EvidenceFormatError);
      expect(() =>
        validateReceiptClaims({ ...base(), verdict, public_denial_reason: "policy_denied" }),
      ).toThrow(EvidenceFormatError);
    },
  );
  const sets = {
    action_class: ACTION_CLASSES,
    side_effect_class: SIDE_EFFECT_CLASSES,
    evidence_level: EVIDENCE_LEVELS,
    sensitivity: SENSITIVITIES,
  };
  it.each(Object.entries(sets))("accepts every entry in %s", (claim, table) => {
    for (const value of table)
      expect(() => validateReceiptClaims({ ...base(), [claim]: value })).not.toThrow();
  });
  it("accepts every denial and result digest table entry", () => {
    for (const verdict of VERDICTS.filter((v) => v !== "compliant"))
      for (const reason of DENIAL_REASONS) {
        validateReceiptClaims({
          ...base(),
          verdict,
          public_denial_reason: reason,
          internal_denial_code: "rule:deny",
        });
      }
    for (const scope of DIGEST_SCOPES)
      for (const canonicalization of DIGEST_CANONICALIZATIONS) {
        validateReceiptClaims({
          ...base(),
          result_hash: { ...base().invocation_digest, scope, canonicalization },
        });
      }
  });
  it("accepts valid parents and budget keys", () => {
    validateReceiptClaims({
      ...base(),
      parent_receipt_hash: "a".repeat(64),
      parent_receipt_id: "a".repeat(16),
      budget_remaining: { "calls.total:read-1": 0 },
    });
    expect(() =>
      validateReceiptClaims({
        ...base(),
        parent_receipt_hash: "a".repeat(64),
        parent_receipt_id: null,
      }),
    ).toThrow(EvidenceFormatError);
  });
});

describe("resumable chain", () => {
  it("chains full compact JWS bytes, and resumes from the durable tail", () => {
    const chain = createEvidenceChain(key, keys.kid);
    const first = chain.append(receiptInput());
    const second = chain.append(receiptInput());
    expect(first.seq).toBe(0);
    expect(first.parentSha256).toBeNull();
    expect(second.parentSha256).toBe(createHash("sha256").update(first.jws, "ascii").digest("hex"));
    const claims = JSON.parse(
      Buffer.from(second.jws.split(".")[1] ?? "", "base64url").toString(),
    ) as ReceiptClaims;
    expect(claims.parent_receipt_id).toBe(first.sha256.slice(0, 16));
    const resumed = resumeChain(
      { lastJws: second.jws, lastSeq: second.seq, expectedRun: receiptInput() },
      key,
      keys.kid,
    );
    expect(resumed.previousJws).toBe(second.jws);
    expect(resumed.nextStep).toBe(2);
    const third = resumed.append(receiptInput());
    expect(third.seq).toBe(2);
    expect(third.parentSha256).toBe(second.sha256);
  });
  it("does not advance after a failed append", () => {
    const chain = createEvidenceChain(keys.privateKeyPem, keys.kid);
    expect(() => chain.append(receiptInput({ target: "" }))).toThrow(EvidenceFormatError);
    expect(chain.nextStep).toBe(0);
    expect(chain.previousJws).toBeNull();
  });
  it.each([
    ["runId", { runId: "run-other" }],
    ["grant_id", { grantId: "grant-other" }],
    ["trace_id", { traceId: "trace-other" }],
    ["run_nonce", { runNonce: "YWJjZGVmMDEyMzQ1Njc4OQ" }],
    ["actor via botId", { botId: "bot-other" }],
    ["actor override", { actor: "actor-other" }],
    ["verifier_id and iss via spaceId", { spaceId: "space-other" }],
    ["verifier_id and iss override", { verifierId: "verifier-other" }],
  ] as const)("rejects another run's same-key tail differing in %s", (_field, overrides) => {
    const record = createEvidenceChain(key, keys.kid).append(receiptInput(overrides));
    expect(() =>
      resumeChain(
        { lastJws: record.jws, lastSeq: record.seq, expectedRun: receiptInput() },
        key,
        keys.kid,
      ),
    ).toThrow(expect.objectContaining({ name: "EvidenceFormatError", code: "tail_mismatch" }));
  });
  it.each(["run-test:00", "run-test:1"])("rejects a nonmatching step_id %s", (step_id) => {
    const lastJws = signReceipt({ ...base(), step_id }, key, keys.kid);
    expect(() =>
      resumeChain({ lastJws, lastSeq: 0, expectedRun: receiptInput() }, key, keys.kid),
    ).toThrow(expect.objectContaining({ code: "tail_mismatch", claim: "step_id" }));
  });
  it.each([
    {
      runId: "run:with:colons",
      actor: "actor-test",
      botId: "ignored",
      verifierId: "verifier-test",
    },
    { spaceId: "space-other", botId: "bot-other" },
  ])("resumes matching resolved identity %#", (overrides) => {
    const input = receiptInput(overrides);
    const record = createEvidenceChain(key, keys.kid).append(input);
    const resumed = resumeChain(
      { lastJws: record.jws, lastSeq: record.seq, expectedRun: input },
      keys.privateKeyPem,
      keys.kid,
    );
    const next = resumed.append(input);
    expect(next.seq).toBe(1);
    expect(next.parentSha256).toBe(record.sha256);
  });
  it("rejects corrupt tails, wrong keys and wrong sequence", () => {
    const record = createEvidenceChain(key, keys.kid).append(receiptInput());
    const expectedRun = receiptInput();
    expect(() =>
      resumeChain({ lastJws: "invalid", lastSeq: 0, expectedRun }, key, keys.kid),
    ).toThrow(EvidenceFormatError);
    expect(() =>
      resumeChain({ lastJws: record.jws, lastSeq: -1, expectedRun }, key, keys.kid),
    ).toThrow(EvidenceFormatError);
    expect(() =>
      resumeChain({ lastJws: record.jws, lastSeq: 1, expectedRun }, key, keys.kid),
    ).toThrow(EvidenceFormatError);
    const other = generateEvidenceKey();
    expect(() =>
      resumeChain({ lastJws: record.jws, lastSeq: 0, expectedRun }, other.privateKeyPem, other.kid),
    ).toThrow(EvidenceFormatError);
  });
});
