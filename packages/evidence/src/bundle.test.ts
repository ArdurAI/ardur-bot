import { describe, expect, it } from "vitest";
import { buildEvidenceBundle, EVIDENCE_CHECK_COMMAND } from "./bundle.js";
import { EvidenceFormatError } from "./errors.js";
import { generateEvidenceKey } from "./keys.js";
import { createEvidenceChain } from "./receipt.js";
import { sealRun } from "./seal.js";
import { receiptInput } from "./test-input.js";
import { verifySeal } from "./verify.js";

function sample() {
  const keys = generateEvidenceKey();
  const chain = createEvidenceChain(keys.privateKeyPem, keys.kid);
  const records = [chain.append(receiptInput()).jws, chain.append(receiptInput()).jws];
  const seal = sealRun(
    {
      records,
      actor: "bot-test",
      grantId: "grant-test",
      iss: "ardur:space-test:evidence",
      now: receiptInput().now,
    },
    keys.privateKeyPem,
    keys.kid,
  );
  return { keys, input: { runId: "run-test", records, seal, publicKeyPem: keys.publicKeyPem } };
}

describe("evidence bundle", () => {
  it("returns only the four portable files with exact newlines and order", () => {
    const { keys, input } = sample();
    const files = buildEvidenceBundle(input);
    expect(files.map((file) => file.path)).toEqual([
      "journal.jsonl",
      "seal.jwt",
      "evidence-public.pem",
      "README.md",
    ]);
    const contents = Object.fromEntries(files.map((file) => [file.path, file.contents]));
    expect(contents["journal.jsonl"]).toBe(
      `${input.records.map((jwt) => JSON.stringify({ jwt })).join("\n")}\n`,
    );
    expect(contents["seal.jwt"]).toBe(`${input.seal}\n`);
    expect(contents["evidence-public.pem"]).toBe(keys.publicKeyPem);
    expect(contents["README.md"]).toContain(EVIDENCE_CHECK_COMMAND);
    expect(contents["README.md"]).toContain("do not independently prove");
    expect(files.some((file) => file.contents.includes(keys.privateKeyPem))).toBe(false);
    expect(verifySeal(input.seal, input.records, contents["evidence-public.pem"] ?? "").ok).toBe(
      true,
    );
  });
  it("refuses invalid bundles and never exports private key material", () => {
    const { keys, input } = sample();
    for (const patch of [
      { runId: "" },
      { records: [] },
      { seal: "bad" },
      { publicKeyPem: keys.privateKeyPem },
      { publicKeyPem: "bad" },
      { publicKeyPem: generateEvidenceKey().publicKeyPem },
    ]) {
      expect(() => buildEvidenceBundle({ ...input, ...patch })).toThrow(EvidenceFormatError);
    }
  });
});
