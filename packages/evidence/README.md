# @ardurbot/evidence

Node-only functions for self-signed decision records, a resumable receipt chain,
a signed end-of-run seal, verification, and a portable bundle compatible with the
Ardur Evidence format. No runtime dependencies or hosted services are required.
Never import this package from apps/web, packages/ui-*, or @ardurbot/core's index.
Server-side composition roots own keys, durable storage, and orchestration.

## Use and boundaries

Generate an EC P-256 key with generateEvidenceKey; store its PKCS#8 private PEM
outside the bundle. Public-key APIs accept SPKI public PEM only. Keys and run
nonces belong to the caller; make the nonce from at least 16 random bytes encoded
as unpadded base64url. Tests generate their own keys, never fixtures with private
keys.

createEvidenceChain(privateKey, kid) starts at sequence 0. append(input) accepts
ReceiptInput without step and returns the compact JWS, receiptId, sha256,
parentSha256 and seq. actor overrides botId; verifierId defaults to
ardur:<spaceId>:evidence. step_id is <runId>:<seq>; receipt_id is a random UUID.
now is a Date or a function returning a Date; seconds are floored.
Optional wire claims use snake_case names as defined in ReceiptClaims.

Persist the record before treating the append as durable. This in-memory helper
cannot make database writes atomic: discard/rebuild it after a failed write.
resumeChain({ lastJws, lastSeq, expectedRun }, privateKey, kid) checks the stored
tail's signature and format, then binds it to the expected run and exact step.
expectedRun is ReceiptRunIdentity: runId, spaceId, grantId, traceId, runNonce,
and actor or botId, with optional verifierId. Identity defaults and overrides
match the builder. A different grant_id, trace_id, run_nonce, actor, verifier_id,
iss or step_id throws EvidenceFormatError with code tail_mismatch. Supply the
actual durable tail; resuming does not check the entire stored history.
One helper belongs to one run and one writer.

sealRun({ records, actor, grantId, iss, now }, privateKey, kid) verifies the chain
and refuses empty chains or mismatched run identities. records is an ordered
array of compact JWS strings. verifyChain and verifySeal accept that same array
and a P-256 public KeyObject or SPKI PEM. They return failures, not exceptions
for malformed evidence. Failure indices are zero-based; -1 means a list/key
error, and records.length means the seal. recordCount counts supplied entries;
headReceiptId is null if the tail could not be verified and validated. Historical
verification checks format and integrity, not current-time JWT validity.

verifyChain also requires every record's grant_id, trace_id, run_nonce, actor,
verifier_id and iss to match record 0. step_id must be exactly <runId>:<index>,
starting at 0; runId is recovered from record 0 before its final colon, so run
IDs may contain colons. Identity or step inconsistencies fail with run_mismatch,
even if all signatures and parent hashes are correct.

Empty journals fail verification with empty_chain at index -1. verifySeal also
retains receipt_chain_head_mismatch for an empty journal with a valid seal.

Verification codes are defined in VERIFICATION_CODES in src/tables.ts:
empty_chain, malformed_jws, header_invalid, kid_mismatch, signature_invalid,
payload_not_canonical, claims_invalid, chain_broken, run_mismatch,
seal_signature_invalid, seal_claims_invalid, seal_missing_chain_head and
receipt_chain_head_mismatch.

buildEvidenceBundle returns four { path, contents } files without filesystem
side effects, after checking the seal against the supplied public key. The
independent check command lives only in the exported EVIDENCE_CHECK_COMMAND in
src/bundle.ts; generated bundle instructions use that constant.

## Wire rules

Receipts use ardur.execution_receipt.v0.2 and application/ardur.er+jwt; seals use
ardur.behavioral_attestation.v0.2 and JWT. Both use canonical JSON and compact
unpadded base64url JWS with SHA-256/P-256 signatures in raw 64-byte r||s format.
kid is sha256: followed by the complete lowercase SHA-256 of the SPKI DER key.

The first receipt has null parents. Every later receipt names the SHA-256 of the
previous full compact JWS, with its first 16 hex characters as parent_receipt_id.
Arguments are not stored: arguments_hash hashes canonical args, and
invocation_digest hashes canonical { tool, args }. Receipts expire 3,600 seconds
after iat; timestamp is that second's UTC instant without milliseconds. The seal
expires after 90 days and binds the last receipt, total records, compliant records
and all other records. A chain alone cannot detect a removed tail; its seal can.

Validation rejects unknown receipt claims, invalid enum entries, malformed
budgets and policy decisions, and denial metadata on compliant receipts. Other
verdicts require both denial fields. Signing emits only self_signed evidence.
Optional metadata without a specified wire constraint must still be JSON.

The canonicalizer sorts keys by UTF-16 code units and never calls toJSON or
getters. Object properties and array items must be data properties. It
rejects lone surrogates, non-finite numbers, unsupported objects/values, array
holes and cycles. Integer-valued numbers outside the safe range are rejected
unless JSON.stringify emits exponent notation, matching the supplied checker
vectors (1e21 is accepted; Number("9007199254740993") is rejected).

## Extending a closed set

Add one entry to the appropriate as const array in src/tables.ts. Its TypeScript
type and is... guard derive from the table; there is no second enum or plugin
registry. Copy the table-driven acceptance case in src/receipt.test.ts and a
bad-value rejection case for the relevant field. Add a checker vector when wire
semantics change; coordinate new entries with the independent checker before
emitting them. Evidence-level entries are recognized by validation, but adding a
stronger level does not implement countersigning or transparency logging.

## Tests

Run from the repository root:

    pnpm exec vitest run packages/evidence --maxWorkers=2
    pnpm --filter @ardurbot/evidence check

Set ARDUR_EVIDENCE_SAMPLE_DIR to an output folder to enable sample-bundle.test.ts.
It writes a four-record run (read, shell decision, denied email, write), its seal,
public key and instructions, plus edited, dropped-middle and dropped-last
journals. It records decisions only; it does not execute those tools.
The independent checker is a separate acceptance step; this package does not
install it. Set ARDUR_EVIDENCE_TIMING=1 to measure 1,000 chained appends and print
p50/p95 milliseconds including claim building, validation, signing and hashing.

## What evidence does not prove

A trusted public key lets a reader detect changes relative to a signed seal. A
bundle's included key is not itself a trust anchor. Self-signed records do not
independently prove that a tool ran, that results or rules are correct, or that
all real events were recorded. Whoever holds the private key can sign a different
history. Callers must redact targets and other metadata before signing; hashes
of arguments are commitments, not encryption.
