import { gunzipSync } from "node:zlib";
import {
  createEvidenceChain,
  generateEvidenceKey,
  loadEvidencePrivateKey,
  sealRun,
} from "@ardurbot/adapters/evidence-format";

export function signedRunFixture(
  runId = "run",
  spaceId = "space",
  botId = "bot",
  keys = generateEvidenceKey(),
) {
  const privateKey = loadEvidencePrivateKey(keys.privateKeyPem);
  const chain = createEvidenceChain(privateKey, keys.kid);
  const kinds = ["allowed_by_default", "asked", "denied"];
  const records = kinds.map((decisionKind, seq) => {
    const verdict = seq === 2 ? "violation" : seq === 1 ? "insufficient_evidence" : "compliant";
    const record = chain.append({
      runId,
      spaceId,
      botId,
      grantId: runId,
      traceId: runId,
      runNonce: "MDEyMzQ1Njc4OWFiY2RlZg",
      tool: "read_file",
      args: { path: "example.txt" },
      actionClass: "read",
      sideEffectClass: "none",
      target: "example.txt",
      resourceFamily: "filesystem",
      verdict,
      reason: "Fixture decision",
      policyDecisions: [],
      budgetRemaining: {},
      ...(verdict !== "compliant"
        ? { public_denial_reason: "policy_denied" as const, internal_denial_code: "fixture" }
        : {}),
    });
    return {
      ...record,
      jws: record.jws,
      spaceId,
      runId,
      kid: keys.kid,
      verdict,
      decisionKind,
      toolName: "read_file",
      createdAt: new Date("2026-09-29T12:00:00Z"),
    };
  });
  const journal = records.map((r) => r.jws);
  const seal = {
    spaceId,
    runId,
    jws: sealRun(
      { records: journal, actor: botId, grantId: runId, iss: `ardur:${spaceId}:evidence` },
      privateKey,
      keys.kid,
    ),
    headSha256: records.at(-1)!.sha256,
    recordCount: records.length,
    gapCount: 0,
    createdAt: new Date(),
  };
  return { keys, records, seal, journal };
}

/** Decode this app's short-path POSIX tar entries without invoking a shell. */
export function extractEvidenceArchive(bytes: Uint8Array): Map<string, string> {
  const tar = gunzipSync(bytes);
  const files = new Map<string, string>();
  for (let offset = 0; tar[offset]; ) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString()
      .split("\0")[0]!;
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString(), 8);
    files.set(name, tar.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
