import { verifyChain, verifySeal } from "@ardurbot/evidence";
import { describe, expect, it, vi } from "vitest";
import { agentConnectionTools, builtinAgentTools } from "../builtin-tools.js";
import { EncryptedSecretStore } from "../secrets.js";
import { DECISION_KINDS, decisionFields } from "./decision-kinds.js";
import type { RecordDecisionInput } from "./recorder.js";
import { createEvidenceRecorder } from "./recorder.js";
import { fakeEvidenceStore } from "./test-store.js";
import { TOOL_CLASSES, toolEvidenceClass } from "./tool-classes.js";

function setup() {
  const fake = fakeEvidenceStore();
  const secretStore = new EncryptedSecretStore("test-only-encryption-material");
  const deps = { store: fake.store, secretStore, logFailure: vi.fn() };
  return { ...fake, deps, recorder: createEvidenceRecorder(deps) };
}
const input: RecordDecisionInput = {
  run: { id: "run-test", spaceId: "space-test", botId: "bot-test", userId: "user-test" },
  toolName: "read_file",
  viaConnector: false,
  args: { path: "/workspace/example.txt" },
  target: { path: "/workspace/example.txt" },
  decisionKind: "allowed_by_default",
};
const decode = (jws: string) =>
  JSON.parse(Buffer.from(jws.split(".")[1]!, "base64url").toString("utf8"));

describe("evidence classification tables", () => {
  it("classifies every builtin, including conditional connection tools", () => {
    for (const tool of [...builtinAgentTools, ...agentConnectionTools]) {
      expect(TOOL_CLASSES, tool.name).toHaveProperty(tool.name);
    }
    expect(toolEvidenceClass("mail_get_and_send", true).sideEffectClass).toBe("external_send");
    expect(toolEvidenceClass("mail_get", true).actionClass).toBe("query");
  });
  it("every decision supplies policy and honest denial fields", () => {
    expect(Object.keys(DECISION_KINDS)).toEqual([
      "allowed_by_rule",
      "allowed_by_default",
      "allowed_by_auto_review",
      "approved_by_owner",
      "asked",
      "denied_by_rule",
      "denied_by_auto_review",
      "denied_by_owner",
      "approval_expired",
      "unanswered_at_run_end",
    ]);
    for (const kind of Object.keys(DECISION_KINDS) as (keyof typeof DECISION_KINDS)[]) {
      const fields = decisionFields(kind, "rule-test");
      expect(fields.policyDecisions[0]?.rule_id).toBe("rule-test");
      if (fields.verdict !== "compliant") expect(fields).toHaveProperty("internal_denial_code");
      else expect(fields).not.toHaveProperty("public_denial_reason");
    }
  });
});

describe("evidence recorder", () => {
  it("does nothing when governance is off and caches the lookup per run", async () => {
    const { store, recorder, records, keys } = setup();
    vi.mocked(store.governanceEnabled).mockResolvedValue(false);
    await recorder.recordDecision(input);
    await recorder.recordDecision(input);
    expect(records).toEqual([]);
    expect(keys).toEqual([]);
    expect(store.governanceEnabled).toHaveBeenCalledTimes(1);
  });
  it("records allowed, asked, approved and denied decisions in a verified chain", async () => {
    const { recorder, records, keys } = setup();
    for (const decisionKind of [
      "allowed_by_rule",
      "asked",
      "approved_by_owner",
      "denied_by_owner",
    ] as const) {
      expect(await recorder.recordDecision({ ...input, decisionKind })).toEqual({ ok: true });
    }
    expect(records.map((row) => row.verdict)).toEqual([
      "compliant",
      "insufficient_evidence",
      "compliant",
      "violation",
    ]);
    expect(decode(records[1]!.jws)).toMatchObject({
      public_denial_reason: "insufficient_evidence",
      internal_denial_code: "approval_pending",
    });
    expect(
      verifyChain(
        records.map((row) => row.jws),
        keys[0]!.publicKeyPem,
      ).ok,
    ).toBe(true);
    expect(keys[0]!.privateKeyCiphertext).not.toContain("PRIVATE KEY");
  });
  it("resumes the same nonce after a restart and serializes concurrent calls", async () => {
    const { recorder, deps, records, keys } = setup();
    await recorder.recordDecision(input);
    const restarted = createEvidenceRecorder(deps);
    await Promise.all([restarted.recordDecision(input), restarted.recordDecision(input)]);
    expect(records.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(records[2]?.parentSha256).toBe(records[1]?.sha256);
    expect(new Set(records.map((row) => decode(row.jws).run_nonce)).size).toBe(1);
    expect(
      verifyChain(
        records.map((row) => row.jws),
        keys[0]!.publicKeyPem,
      ).ok,
    ).toBe(true);
  });
  it("recovers a competing writer's sequence conflict", async () => {
    const { recorder, deps, records, keys } = setup();
    await recorder.recordDecision(input);
    const competing = createEvidenceRecorder(deps);
    await competing.recordDecision(input);
    expect(await recorder.recordDecision(input)).toEqual({ ok: true });
    expect(records.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(
      verifyChain(
        records.map((row) => row.jws),
        keys[0]!.publicKeyPem,
      ).ok,
    ).toBe(true);
  });
  it("deduplicates the same durable decision across concurrent writers and restarts", async () => {
    const { recorder, deps, records, keys } = setup();
    const decision = { ...input, decisionId: "call-1:allowed_by_default" };
    const competing = createEvidenceRecorder(deps);
    expect(
      await Promise.all([recorder.recordDecision(decision), competing.recordDecision(decision)]),
    ).toEqual([{ ok: true }, { ok: true }]);
    expect(await createEvidenceRecorder(deps).recordDecision(decision)).toEqual({ ok: true });
    expect(records).toHaveLength(1);
    expect(
      verifyChain(
        records.map((row) => row.jws),
        keys[0]!.publicKeyPem,
      ).ok,
    ).toBe(true);
  });
  it("flushes a gap after storage recovers before sealing", async () => {
    const { recorder, store, records, seals } = setup();
    await recorder.recordDecision(input);
    const noteGap = store.noteGap;
    store.noteGap = vi
      .fn()
      .mockRejectedValueOnce(new Error("Storage unavailable"))
      .mockImplementation(noteGap);
    vi.mocked(store.insertRecord).mockRejectedValueOnce(new Error("Storage unavailable"));
    expect((await recorder.recordDecision(input)).ok).toBe(false);
    expect(await recorder.sealRunEvidence(input.run.id)).toEqual({ ok: true });
    expect(records).toHaveLength(1);
    expect(seals[0]?.gapCount).toBe(1);
  });
  it("never stores arguments, message bodies, query strings or secret targets", async () => {
    const { recorder, records } = setup();
    const secret = "sk-test-only-sensitive-value";
    await recorder.recordDecision({
      ...input,
      args: { token: secret, body: "PRIVATE MESSAGE CONTENT", contents: "PRIVATE FILE CONTENT" },
      target: { path: `/workspace/${secret}` },
    });
    await recorder.recordDecision({
      ...input,
      toolName: "web_fetch",
      args: { url: `https://example.test/path?token=${secret}` },
      target: { host: `https://user:${secret}@example.test/path?token=${secret}` },
    });
    const payloads = records.map((row) => JSON.stringify(decode(row.jws))).join("\n");
    for (const value of [secret, "PRIVATE MESSAGE CONTENT", "PRIVATE FILE CONTENT", "?token="])
      expect(payloads).not.toContain(value);
    expect(decode(records[1]!.jws).target).toBe("web_fetch:example.test");
  });
  it("returns failures without throwing, discards the undurable tail and counts gaps", async () => {
    const { recorder, store, records, keys } = setup();
    await recorder.recordDecision(input);
    vi.mocked(store.insertRecord).mockRejectedValueOnce(new Error("storage unavailable"));
    expect(await recorder.recordDecision(input)).toEqual({ ok: false, reason: "recording_failed" });
    await recorder.recordDecision(input);
    expect(records.map((row) => row.seq)).toEqual([0, 1]);
    expect(await store.gapCount(input.run.id)).toBe(1);
    expect(
      verifyChain(
        records.map((row) => row.jws),
        keys[0]!.publicKeyPem,
      ).ok,
    ).toBe(true);
  });
  it("rejects a restart under a different bot identity", async () => {
    const { recorder, deps, records } = setup();
    await recorder.recordDecision(input);
    expect(
      (
        await createEvidenceRecorder(deps).recordDecision({
          ...input,
          run: { ...input.run, botId: "other-bot" },
        })
      ).ok,
    ).toBe(false);
    expect(records).toHaveLength(1);
  });
  it("verifies and seals once, naming the last receipt and gap count", async () => {
    const { recorder, store, records, keys, seals } = setup();
    await recorder.recordDecision(input);
    await store.noteGap(input.run.id);
    expect(await recorder.sealRunEvidence(input.run.id)).toEqual({ ok: true });
    expect(await recorder.sealRunEvidence(input.run.id)).toEqual({ ok: true });
    expect(seals).toHaveLength(1);
    expect(seals[0]).toMatchObject({ headSha256: records[0]!.sha256, recordCount: 1, gapCount: 1 });
    expect(
      verifySeal(
        seals[0]!.jws,
        records.map((row) => row.jws),
        keys[0]!.publicKeyPem,
      ).ok,
    ).toBe(true);
  });
  it("does not seal an empty or invalid chain and logs only failure codes", async () => {
    const { recorder, deps, records, seals } = setup();
    expect(await recorder.sealRunEvidence(input.run.id)).toEqual({ ok: true });
    expect(seals).toEqual([]);
    await recorder.recordDecision(input);
    records[0]!.jws = "corrupted";
    expect(await recorder.sealRunEvidence(input.run.id)).toEqual({
      ok: false,
      reason: "chain_invalid",
    });
    expect(seals).toEqual([]);
    expect(deps.logFailure).toHaveBeenCalledWith(["malformed_jws"]);
  });
});
