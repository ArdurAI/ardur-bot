import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildEvidenceBundle } from "./bundle.js";
import { canonicalize } from "./jcs.js";
import { decodeCompact } from "./jws.js";
import { generateEvidenceKey } from "./keys.js";
import { createEvidenceChain } from "./receipt.js";
import { sealRun } from "./seal.js";
import { receiptInput } from "./test-input.js";
import { verifyChain, verifySeal } from "./verify.js";

const directory = process.env.ARDUR_EVIDENCE_SAMPLE_DIR;
it.skipIf(!directory)("writes a four-decision sample bundle and tampered journals", () => {
  if (!directory) return;
  const keys = generateEvidenceKey();
  const chain = createEvidenceChain(keys.privateKeyPem, keys.kid);
  const records = [
    chain.append(receiptInput()).jws,
    chain.append(
      receiptInput({
        tool: "shell",
        args: { command: "printf example" },
        actionClass: "execute",
        sideEffectClass: "process_launch",
        target: "sandbox",
        resourceFamily: "process",
      }),
    ).jws,
    chain.append(
      receiptInput({
        tool: "send_email",
        args: { to: "recipient@example.test", subject: "Example" },
        actionClass: "send",
        sideEffectClass: "external_send",
        target: "redacted-recipient",
        resourceFamily: "email",
        verdict: "violation",
        reason: "Sending is denied",
        public_denial_reason: "policy_denied",
        internal_denial_code: "rule.email-denied",
      }),
    ).jws,
    chain.append(
      receiptInput({
        tool: "write_file",
        args: { path: "output.txt", content: "Example" },
        actionClass: "write",
        sideEffectClass: "filesystem_write",
        target: "output.txt",
      }),
    ).jws,
  ];
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
  const bundle = buildEvidenceBundle({
    runId: "run-test",
    records,
    seal,
    publicKeyPem: keys.publicKeyPem,
  });
  mkdirSync(directory, { recursive: true });
  for (const file of bundle)
    writeFileSync(join(directory, file.path), file.contents, { mode: 0o600 });
  const edited = [...records];
  const parts = (edited[1] ?? "").split(".");
  parts[1] = Buffer.from(
    canonicalize({ ...(decodeCompact(edited[1]).payload as object), target: "edited" }),
  ).toString("base64url");
  edited[1] = parts.join(".");
  const variants = {
    "journal-edited.jsonl": edited,
    "journal-dropped-middle.jsonl": records.filter((_, index) => index !== 1),
    "journal-dropped-last.jsonl": records.slice(0, -1),
  };
  for (const [name, journal] of Object.entries(variants))
    writeFileSync(
      join(directory, name),
      `${journal.map((jwt) => JSON.stringify({ jwt })).join("\n")}\n`,
      { mode: 0o600 },
    );
  expect(verifySeal(seal, records, keys.publicKeyPem).ok).toBe(true);
  expect(verifyChain(variants["journal-edited.jsonl"], keys.publicKeyPem).ok).toBe(false);
  expect(verifyChain(variants["journal-dropped-middle.jsonl"], keys.publicKeyPem).ok).toBe(false);
  expect(verifyChain(variants["journal-dropped-last.jsonl"], keys.publicKeyPem).ok).toBe(true);
  for (const journal of Object.values(variants))
    expect(verifySeal(seal, journal, keys.publicKeyPem).ok).toBe(false);
});
