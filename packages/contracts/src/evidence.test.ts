import { expect, expectTypeOf, it } from "vitest";
import type { EvidenceSigningIdentity } from "./evidence.js";
import {
  EvidenceSigningIdentitySchema,
  evidenceContract,
  evidenceIdentityCard,
} from "./evidence.js";

const identity = {
  fingerprint: `sha256:${"a".repeat(64)}`,
  scope: { type: "space" as const, id: "space" },
  keyVersion: 1 as const,
};
it("allows exactly the public identity fields in the response type and value", () => {
  expectTypeOf<keyof EvidenceSigningIdentity>().toEqualTypeOf<
    "fingerprint" | "scope" | "keyVersion"
  >();
  expect(EvidenceSigningIdentitySchema.parse(identity)).toEqual(identity);
  expect(JSON.parse(evidenceIdentityCard(identity))).toEqual(identity);
  for (const field of ["privateKeyPem", "privateKeyCiphertext", "secretRecordId"]) {
    expect(() =>
      EvidenceSigningIdentitySchema.parse({ ...identity, [field]: "must-not-leak" }),
    ).toThrow();
    expect(() => evidenceIdentityCard({ ...identity, [field]: "must-not-leak" })).toThrow();
  }
  expect(() =>
    EvidenceSigningIdentitySchema.parse({ ...identity, fingerprint: "PRIVATE KEY" }),
  ).toThrow();
});
it("accepts only a complete expected public fingerprint at the API boundary", () => {
  const schema = evidenceContract.runSummary["~orpc"].inputSchema!;
  expect(schema.parse({ runId: "run", expectedFingerprint: identity.fingerprint })).toEqual({
    runId: "run",
    expectedFingerprint: identity.fingerprint,
  });
  expect(schema.parse({ runId: "run" })).toEqual({ runId: "run" });
  expect(() => schema.parse({ runId: "run", expectedFingerprint: "short" })).toThrow();
});
