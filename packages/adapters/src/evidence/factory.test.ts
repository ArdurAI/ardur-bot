import type * as DbModule from "@ardurbot/db";
import type { EvidenceStore, PrismaClient } from "@ardurbot/db";
import { verifyChain, verifySeal } from "@ardurbot/evidence";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { EVIDENCE_RECORDING_ERROR, recordToolDecision } from "./executor.js";
import { createRunEvidenceRecorder } from "./factory.js";
import type { RecordDecisionInput } from "./recorder.js";
import { fakeEvidenceStore } from "./test-store.js";

const evidenceStore = vi.hoisted(() => vi.fn<(prisma: PrismaClient) => EvidenceStore>());

vi.mock("@ardurbot/db", async (original) => ({
  ...(await original<typeof DbModule>()),
  createEvidenceStore: evidenceStore,
}));

const input: RecordDecisionInput = {
  run: { id: "run-test", spaceId: "space-test", botId: "bot-test", userId: "user-test" },
  toolName: "shell",
  viaConnector: false,
  args: { command: "fixture command" },
  decisionKind: "allowed_by_default",
};

function setup() {
  const fake = fakeEvidenceStore();
  evidenceStore.mockReturnValue(fake.store);
  const prisma = {} as PrismaClient;
  const recorder = createRunEvidenceRecorder({
    prisma,
    secretStore: new EncryptedSecretStore("test-only-encryption-material"),
  });
  expect(evidenceStore).toHaveBeenLastCalledWith(prisma);
  return { ...fake, recorder };
}

describe("production recorder factory", () => {
  it("constructs a real recorder that signs and seals governance-enabled decisions", async () => {
    const { recorder, records, keys, seals } = setup();
    expect(await recordToolDecision(recorder, input)).toBeUndefined();
    expect(records).toHaveLength(1);
    expect(keys).toHaveLength(1);
    const journal = records.map((record) => record.jws);
    expect(verifyChain(journal, keys[0]!.publicKeyPem).ok).toBe(true);
    expect(await recorder.sealRunEvidence(input.run.id)).toEqual({ ok: true });
    expect(seals).toHaveLength(1);
    expect(verifySeal(seals[0]!.jws, journal, keys[0]!.publicKeyPem).ok).toBe(true);
  });

  it("preserves fail-closed writes and counted read gaps on storage failure", async () => {
    const { store, recorder } = setup();
    vi.mocked(store.insertRecord).mockRejectedValue(new Error("Storage unavailable"));
    expect(await recordToolDecision(recorder, input)).toEqual({ error: EVIDENCE_RECORDING_ERROR });
    expect(await recordToolDecision(recorder, { ...input, toolName: "read_file" })).toBeUndefined();
    expect(await store.gapCount(input.run.id)).toBe(2);
  });

  it("keeps governance-off runs unrecorded and without gaps", async () => {
    const { store, recorder, records, keys } = setup();
    vi.mocked(store.governanceEnabled).mockResolvedValue(false);
    expect(await recordToolDecision(recorder, input)).toBeUndefined();
    expect(records).toEqual([]);
    expect(keys).toEqual([]);
    expect(await store.gapCount(input.run.id)).toBe(0);
  });
});
