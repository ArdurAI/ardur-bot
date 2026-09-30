import { EvidenceFormatError, isNonemptyString, requireClaim } from "./errors.js";
import { loadEvidencePublicKey } from "./keys.js";
import { verifySeal } from "./verify.js";

export const EVIDENCE_CHECK_COMMAND =
  "ardur verify --chain-only --receipt-public-key evidence-public.pem --seal seal.jwt journal.jsonl";
export interface EvidenceBundleFile {
  path: string;
  contents: string;
}
export interface EvidenceBundleInput {
  runId: string;
  records: readonly string[];
  seal: string;
  publicKeyPem: string;
}

export function buildEvidenceBundle({
  runId,
  records,
  seal,
  publicKeyPem,
}: EvidenceBundleInput): EvidenceBundleFile[] {
  requireClaim(isNonemptyString(runId), "runId");
  let publicPem: string;
  try {
    publicPem = loadEvidencePublicKey(publicKeyPem)
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch {
    throw new EvidenceFormatError(
      "invalid_key",
      "publicKeyPem",
      "Expected an EC P-256 SPKI public key",
    );
  }
  requireClaim(
    verifySeal(seal, records, publicPem).ok,
    "seal",
    "Bundle requires a valid sealed chain",
  );
  return [
    {
      path: "journal.jsonl",
      contents: `${records.map((jwt) => JSON.stringify({ jwt })).join("\n")}\n`,
    },
    { path: "seal.jwt", contents: `${seal}\n` },
    { path: "evidence-public.pem", contents: publicPem },
    {
      path: "README.md",
      contents: `Ardur Evidence bundle

Run: ${JSON.stringify(runId)}

This bundle contains signed decision records, a signed end-of-run seal, and the public key needed to check them. The journal is in recorded order; the seal names its final record and decision totals.

With the trusted public key, verification detects edits, missing middle records, a removed tail, and records added after the seal. Without the seal, a removed tail cannot be detected. Confirm the public key through a source you trust: replacing the entire bundle and its key is not detectable from the bundle alone.

These records are self-signed statements about decisions. They do not independently prove that a tool ran, that its results were true, that the rules were correct, or that every real-world event was recorded. Anyone holding the private key can create a different signed history. Arguments are hashed, not included; the caller is responsible for redacting targets and other metadata.

From this folder, run the independent Ardur Evidence checker:

${EVIDENCE_CHECK_COMMAND}
`,
    },
  ];
}
