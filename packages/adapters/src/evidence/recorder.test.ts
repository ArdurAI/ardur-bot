import { verifyChain, verifySeal } from "@ardurbot/evidence";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it.each(["governance_off", "no_records", "invalid_chain", "already_sealed"])(
    "releases per-run lookups on the %s terminal path",
    async (path) => {
      const { recorder, store, records } = setup();
      if (path === "governance_off") vi.mocked(store.governanceEnabled).mockResolvedValue(false);
      if (path === "no_records")
        vi.mocked(store.insertRecord).mockRejectedValueOnce(new Error("Storage unavailable"));
      await recorder.recordDecision(input);
      if (path === "invalid_chain") records[0]!.jws = "corrupted";
      await recorder.sealRunEvidence(input.run.id);
      if (path === "already_sealed") {
        await recorder.recordDecision(input);
        await recorder.sealRunEvidence(input.run.id);
      }
      const before = vi.mocked(store.governanceEnabled).mock.calls.length;
      await recorder.recordDecision(input);
      expect(store.governanceEnabled).toHaveBeenCalledTimes(before + 1);
    },
  );
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["sealForRun", "recordsForRun", "keyByKid", "gapCount"] as const)(
  "does not resume sealing writes after the deadline while %s is waiting",
  async (blockedStep) => {
    vi.useFakeTimers();
    const { recorder, store, records, keys, seals } = setup();
    await recorder.recordDecision(input);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    if (blockedStep === "sealForRun") {
      vi.spyOn(store, "sealForRun").mockImplementationOnce(async () => {
        await gate;
        return null;
      });
    } else if (blockedStep === "recordsForRun") {
      vi.spyOn(store, "recordsForRun").mockImplementationOnce(async () => {
        await gate;
        return records;
      });
    } else if (blockedStep === "keyByKid") {
      vi.spyOn(store, "keyByKid").mockImplementationOnce(async () => {
        await gate;
        return keys[0]!;
      });
    } else {
      vi.spyOn(store, "gapCount").mockImplementationOnce(async () => {
        await gate;
        return 0;
      });
    }
    const insertSeal = vi.spyOn(store, "insertSeal");
    const noteGap = vi.spyOn(store, "noteGap");
    const sealing = recorder.sealRunEvidence(input.run.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await sealing).toEqual({ ok: false, reason: "sealing_failed" });
    expect(noteGap).toHaveBeenCalledTimes(1);
    expect(await store.gapCount(input.run.id)).toBe(1);

    // Leave a queued timeout's gap pending so a late second flush is observable.
    noteGap.mockRejectedValueOnce(new Error("Gap storage unavailable"));
    const queuedRecording = recorder.recordDecision(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await queuedRecording).toEqual({ ok: false, reason: "recording_failed" });
    expect(noteGap).toHaveBeenCalledTimes(2);
    resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(insertSeal).not.toHaveBeenCalled();
    expect(seals).toHaveLength(0);
    expect(noteGap).toHaveBeenCalledTimes(2);
    expect(await store.gapCount(input.run.id)).toBe(1);

    expect(await recorder.recordDecision(input)).toEqual({ ok: true });
    const lookups = vi.mocked(store.governanceEnabled).mock.calls.length;
    expect(await recorder.recordDecision(input)).toEqual({ ok: true });
    expect(store.governanceEnabled).toHaveBeenCalledTimes(lookups);
    expect(await store.gapCount(input.run.id)).toBe(2);
  },
);

it.each(["lastRecord", "activeKey"] as const)(
  "does not insert a record after the deadline without a caller signal while %s is waiting",
  async (blockedStep) => {
    vi.useFakeTimers();
    const { recorder, store, deps, records, keys } = setup();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(store, blockedStep).mockImplementationOnce(async () => {
      await gate;
      return null;
    });
    const insertRecord = vi.mocked(store.insertRecord);
    const insertKey = vi.spyOn(store, "insertKey");
    const put = vi.spyOn(deps.secretStore, "put");
    const noteGap = vi.spyOn(store, "noteGap");
    const recording = recorder.recordDecision(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await recording).toEqual({ ok: false, reason: "recording_failed" });
    expect(noteGap).toHaveBeenCalledTimes(1);
    expect(await store.gapCount(input.run.id)).toBe(1);

    resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(insertRecord).not.toHaveBeenCalled();
    expect(insertKey).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    expect(keys).toHaveLength(0);
    expect(noteGap).toHaveBeenCalledTimes(1);
    expect(await store.gapCount(input.run.id)).toBe(1);
  },
);

it("counts a failed recording once when its gap write recovers after the deadline", async () => {
  vi.useFakeTimers();
  const { recorder, store, records } = setup();
  vi.mocked(store.insertRecord).mockRejectedValueOnce(new Error("Record storage unavailable"));
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const originalNoteGap = store.noteGap;
  const noteGap = vi.spyOn(store, "noteGap").mockImplementationOnce(async (runId) => {
    await gate;
    await originalNoteGap(runId);
  });
  const recording = recorder.recordDecision(input);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await recording).toEqual({ ok: false, reason: "recording_failed" });
  expect(noteGap).toHaveBeenCalledTimes(1);
  resume();
  await vi.advanceTimersByTimeAsync(0);
  expect(noteGap).toHaveBeenCalledTimes(1);
  expect(await store.gapCount(input.run.id)).toBe(1);
  expect(records).toHaveLength(0);
  expect(await recorder.recordDecision(input)).toEqual({ ok: true });
  expect(await store.gapCount(input.run.id)).toBe(1);
});

it("finishes a stalled gap flush after a sealing deadline but never writes the seal", async () => {
  vi.useFakeTimers();
  const { recorder, store, seals } = setup();
  await recorder.recordDecision(input);
  const originalNoteGap = store.noteGap;
  const noteGap = vi.spyOn(store, "noteGap");
  noteGap.mockRejectedValueOnce(new Error("Gap storage unavailable"));
  vi.mocked(store.insertRecord).mockRejectedValueOnce(new Error("Record storage unavailable"));
  expect(await recorder.recordDecision(input)).toEqual({ ok: false, reason: "recording_failed" });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  noteGap.mockClear().mockImplementationOnce(async (runId) => {
    await gate;
    await originalNoteGap(runId);
  });
  const insertSeal = vi.spyOn(store, "insertSeal");
  const sealing = recorder.sealRunEvidence(input.run.id);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await sealing).toEqual({ ok: false, reason: "sealing_failed" });
  expect(noteGap).toHaveBeenCalledTimes(1);
  resume();
  await vi.advanceTimersByTimeAsync(0);
  // Sealing is the last step, so no later step would retry: the started flush persists both
  // the earlier recording gap and the timeout's own gap once storage recovers.
  expect(noteGap).toHaveBeenCalledTimes(2);
  expect(await store.gapCount(input.run.id)).toBe(2);
  expect(insertSeal).not.toHaveBeenCalled();
  expect(seals).toHaveLength(0);
  // Nothing stays pending for a later step to repeat.
  expect(await recorder.recordDecision(input)).toEqual({ ok: true });
  expect(noteGap).toHaveBeenCalledTimes(2);
  expect(await store.gapCount(input.run.id)).toBe(2);
});

it("bounds a forever-blocked recording, keeps the reply free and records a partial receipt", async () => {
  vi.useFakeTimers();
  const { recorder, store, records } = setup();
  await recorder.recordDecision(input);
  vi.mocked(store.insertRecord).mockImplementationOnce(() => new Promise(() => {}));
  let recordingSettled = false;
  const recording = recorder.recordDecision(input).then((result) => {
    recordingSettled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(recordingSettled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(recordingSettled).toBe(true);
  expect(await recording).toEqual({ ok: false, reason: "recording_failed" });
  expect(await store.gapCount(input.run.id)).toBe(1);
  expect(records).toHaveLength(1);
  const seal = recorder.sealRunEvidence(input.run.id);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await seal).toEqual({ ok: false, reason: "sealing_failed" });
  expect(await store.sealForRun(input.run.id)).toBeNull();
});

it("bounds a hung seal without claiming verified evidence", async () => {
  vi.useFakeTimers();
  const { recorder, store, seals } = setup();
  await recorder.recordDecision(input);
  store.insertSeal = vi.fn(() => new Promise<never>(() => {}));
  let sealingSettled = false;
  const sealing = recorder.sealRunEvidence(input.run.id).then((result) => {
    sealingSettled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(sealingSettled).toBe(true);
  expect(await sealing).toEqual({ ok: false, reason: "sealing_failed" });
  expect(seals).toHaveLength(0);
  expect(await store.gapCount(input.run.id)).toBe(1);
});

it("counts two concurrent timeouts exactly once while a decision joins the gap flush", async () => {
  vi.useFakeTimers();
  const { recorder, store, records } = setup();
  await recorder.recordDecision(input);
  let releaseRecord!: () => void;
  const recordGate = new Promise<void>((resolve) => {
    releaseRecord = resolve;
  });
  const insertRecord = store.insertRecord;
  vi.mocked(store.insertRecord).mockImplementationOnce(async (data) => {
    await recordGate;
    return insertRecord(data);
  });
  let releaseGap!: () => void;
  const gapGate = new Promise<void>((resolve) => {
    releaseGap = resolve;
  });
  const noteGap = store.noteGap;
  store.noteGap = vi.fn(async (runId) => {
    await gapGate;
    await noteGap(runId);
  });
  const first = recorder.recordDecision(input);
  const second = recorder.recordDecision(input);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await Promise.all([first, second])).toEqual([
    { ok: false, reason: "recording_failed" },
    { ok: false, reason: "recording_failed" },
  ]);
  const concurrent = recorder.recordDecision(input);
  releaseRecord();
  await vi.advanceTimersByTimeAsync(0);
  // The timeout flush and queued decisions must share the same gap writer.
  expect(store.noteGap).toHaveBeenCalledTimes(1);
  releaseGap();
  expect(await concurrent).toEqual({ ok: true });
  expect(store.noteGap).toHaveBeenCalledTimes(2);
  expect(await store.gapCount(input.run.id)).toBe(2);
  // The first insert was already submitted; the second timed out before it could start.
  expect(records).toHaveLength(3);
  await recorder.sealRunEvidence(input.run.id);
  expect(await store.gapCount(input.run.id)).toBe(2);
});

it("does not hold timed-out replies on a forever-blocked gap store", async () => {
  vi.useFakeTimers();
  const { recorder, store } = setup();
  await recorder.recordDecision(input);
  vi.mocked(store.insertRecord).mockImplementationOnce(() => new Promise(() => {}));
  store.noteGap = vi.fn(() => new Promise<void>(() => {}));
  const replies = [recorder.recordDecision(input), recorder.recordDecision(input)];
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await Promise.all(replies)).toEqual([
    { ok: false, reason: "recording_failed" },
    { ok: false, reason: "recording_failed" },
  ]);
  expect(store.noteGap).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await store.sealForRun(input.run.id)).toBeNull();
});

it.each(["activeKey", "secretPut", "insertKey"] as const)(
  "does not start another write after cancellation while %s is waiting",
  async (blockedStep) => {
    const { recorder, store, deps, records, keys } = setup();
    const controller = new AbortController();
    let resume!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const originalInsertKey = store.insertKey;
    const originalPut = deps.secretStore.put.bind(deps.secretStore);
    const insertKey = vi.spyOn(store, "insertKey");
    const insertRecord = vi.mocked(store.insertRecord);
    const put = vi.spyOn(deps.secretStore, "put");
    if (blockedStep === "activeKey") {
      store.activeKey = vi.fn(async () => {
        started();
        await gate;
        return null;
      });
    } else if (blockedStep === "secretPut") {
      const original = originalPut;
      // Keep the real encryption behavior, but delay its return to the recorder.
      put.mockImplementationOnce(async (...args) => {
        const result = await original(...args);
        started();
        await gate;
        return result;
      });
    } else {
      const original = originalInsertKey;
      insertKey.mockImplementationOnce(async (data) => {
        started();
        await gate;
        return original(data);
      });
    }
    const recording = recorder.recordDecision(input, controller.signal);
    await waiting;
    controller.abort();
    resume();
    expect(await recording).toEqual({ ok: false, reason: "recording_failed" });
    expect(insertRecord).not.toHaveBeenCalled();
    expect(records).toHaveLength(0);
    expect(await store.gapCount(input.run.id)).toBe(0);
    if (blockedStep === "activeKey") expect(put).not.toHaveBeenCalled();
    if (blockedStep !== "insertKey") {
      expect(insertKey).not.toHaveBeenCalled();
      expect(keys).toHaveLength(0);
    }
  },
);
