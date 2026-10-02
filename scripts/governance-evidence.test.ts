import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { EVIDENCE_STATES } from "../packages/contracts/src/evidence-states";
import { EVIDENCE_CHECK_COMMAND } from "../packages/evidence/src/bundle";

const document = readFileSync(new URL("../docs/governance.md", import.meta.url), "utf8").replace(
  /\s+/g,
  " ",
);
it("documents the exact independent bundle check command and every shared state", () => {
  expect(document).toContain(EVIDENCE_CHECK_COMMAND);
  for (const entry of Object.values(EVIDENCE_STATES))
    expect(document).toContain(`| ${entry.labelMessageId} |`);
  for (const file of ["journal.jsonl", "seal.jwt", "evidence-public.pem", "README.md"])
    expect(document).toContain(`\`${file}\``);
});
it("states trust limitations and does not advertise encryption or tool execution proof", () => {
  expect(document).toContain("not an independent trust anchor");
  expect(document).toContain("not encrypted");
  expect(document).toContain("does **not** prove that the app is honest");
  expect(document).toContain("paired RPC transport does not carry HTTP archive downloads");
  expect(document).not.toContain("not part of this build yet");
});
