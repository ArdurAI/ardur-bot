import { getLogger } from "@ardurbot/logging";
import { afterEach, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { createEvidenceRecorder } from "./recorder.js";
import { createEvidenceSealer } from "./seal.js";
import { fakeEvidenceStore } from "./test-store.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("bounds hung seal preparation without holding terminal work or claiming complete evidence", async () => {
  vi.useFakeTimers();
  const { store, seals } = fakeEvidenceStore();
  store.recordsForRun = vi.fn(() => new Promise<never>(() => {}));
  const recorder = createEvidenceRecorder({
    store,
    secretStore: new EncryptedSecretStore("fixture-material"),
  });
  const seal = createEvidenceSealer({ prisma: {} as never, store, recorder });
  let settled = false;
  const sealing = seal("run-test").then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(59_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  expect(await sealing).toEqual({ ok: false, reason: "sealing_failed" });
  expect(seals).toHaveLength(0);
  expect(await store.gapCount("run-test")).toBe(1);
});

it.each(["sealForRun", "recordsForRun", "run", "effect", "binding"] as const)(
  "abandons seal preparation without late writes when %s resumes after its deadline",
  async (blockedRead) => {
    vi.useFakeTimers();
    const { store, records, seals } = fakeEvidenceStore();
    const run = { id: "run-test", spaceId: "space-test", botId: "bot-test", userId: "user-test" };
    const recorder = createEvidenceRecorder({
      store,
      secretStore: new EncryptedSecretStore("fixture-material"),
    });
    await recorder.recordDecision({
      run,
      toolName: "read_file",
      viaConnector: false,
      args: {},
      decisionKind: "asked",
      decisionId: "effect:effect-test:asked",
    });
    const prisma = {
      run: { findUniqueOrThrow: vi.fn(async () => run) },
      externalEffect: {
        findUnique: vi.fn(async () => ({ runId: run.id, status: "pending", request: {} })),
      },
      deviceApprovalBinding: { findUnique: vi.fn(async () => null) },
    };
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    if (blockedRead === "sealForRun") {
      const read = store.sealForRun;
      store.sealForRun = vi.fn(async (id) => {
        await gate;
        return read(id);
      });
    } else if (blockedRead === "recordsForRun") {
      const read = store.recordsForRun;
      store.recordsForRun = vi.fn(async (id) => {
        await gate;
        return read(id);
      });
    } else {
      const read =
        blockedRead === "run"
          ? prisma.run.findUniqueOrThrow
          : blockedRead === "effect"
            ? prisma.externalEffect.findUnique
            : prisma.deviceApprovalBinding.findUnique;
      read.mockImplementationOnce(async () => {
        await gate;
        return (blockedRead === "run" ? run : null) as never;
      });
    }
    const record = vi.spyOn(recorder, "recordDecision");
    const sealRun = vi.spyOn(recorder, "sealRunEvidence");
    const warn = vi.spyOn(getLogger(), "warn");
    const sealing = createEvidenceSealer({ prisma: prisma as never, store, recorder })(run.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await sealing).toEqual({ ok: false, reason: "sealing_failed" });
    resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(record).not.toHaveBeenCalled();
    expect(sealRun).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(seals).toHaveLength(0);
    expect(await store.gapCount(run.id)).toBe(1);
    expect(warn.mock.calls.filter(([event]) => event === "run.step.abandoned")).toEqual([
      ["run.step.abandoned", { step: "seal-prepare" }],
    ]);
  },
);

it("abandons a seal decision already waiting in the recorder queue", async () => {
  vi.useFakeTimers();
  const { store, records, seals } = fakeEvidenceStore();
  const run = { id: "run-test", spaceId: "space-test", botId: "bot-test", userId: "user-test" };
  const recorder = createEvidenceRecorder({
    store,
    secretStore: new EncryptedSecretStore("fixture-material"),
  });
  const input = {
    run,
    toolName: "read_file",
    viaConnector: false,
    args: {},
    decisionKind: "asked" as const,
  };
  await recorder.recordDecision({ ...input, decisionId: "effect:effect-test:asked" });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const insertRecord = store.insertRecord;
  vi.mocked(store.insertRecord).mockImplementationOnce(async (data) => {
    await gate;
    return insertRecord(data);
  });
  const blocking = recorder.recordDecision({ ...input, decisionKind: "allowed_by_default" });
  await vi.advanceTimersByTimeAsync(1_000);
  const prisma = {
    run: { findUniqueOrThrow: vi.fn(async () => run) },
    externalEffect: {
      findUnique: vi.fn(async () => ({ runId: run.id, status: "pending", request: {} })),
    },
    deviceApprovalBinding: { findUnique: vi.fn(async () => null) },
  };
  const record = vi.spyOn(recorder, "recordDecision");
  const warn = vi.spyOn(getLogger(), "warn");
  const sealing = createEvidenceSealer({ prisma: prisma as never, store, recorder })(run.id);
  await vi.advanceTimersByTimeAsync(0);
  expect(record).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await blocking).toEqual({ ok: false, reason: "recording_failed" });
  expect(await sealing).toEqual({ ok: false, reason: "sealing_failed" });
  resume();
  await vi.advanceTimersByTimeAsync(0);
  // Only the storage write admitted before the deadline may finish.
  expect(records).toHaveLength(2);
  expect(records.some((row) => row.decisionKind === "unanswered_at_run_end")).toBe(false);
  expect(seals).toHaveLength(0);
  expect(warn.mock.calls.filter(([event]) => event === "run.step.abandoned")).toHaveLength(1);
});

it.each(["unanswered_at_run_end", "denied_by_owner", "approval_expired"] as const)(
  "records and seals %s normally before the preparation deadline",
  async (decisionKind) => {
    const { store, records, seals } = fakeEvidenceStore();
    const run = { id: "run-test", spaceId: "space-test", botId: "bot-test", userId: "user-test" };
    const recorder = createEvidenceRecorder({
      store,
      secretStore: new EncryptedSecretStore("fixture-material"),
    });
    await recorder.recordDecision({
      run,
      toolName: "read_file",
      viaConnector: false,
      args: {},
      decisionKind: "asked",
      decisionId: "effect:effect-test:asked",
    });
    const prisma = {
      run: { findUniqueOrThrow: vi.fn(async () => run) },
      externalEffect: {
        findUnique: vi.fn(async () => ({
          runId: run.id,
          status: decisionKind === "denied_by_owner" ? "denied" : "pending",
          request: {},
        })),
      },
      deviceApprovalBinding: {
        findUnique: vi.fn(async () =>
          decisionKind === "approval_expired" ? { expiresAt: new Date(0) } : null,
        ),
      },
    };
    expect(
      await createEvidenceSealer({ prisma: prisma as never, store, recorder })(run.id),
    ).toEqual({ ok: true });
    expect(records.map((row) => row.decisionKind)).toEqual(["asked", decisionKind]);
    expect(seals).toHaveLength(1);
    expect(seals[0]?.gapCount).toBe(0);
  },
);
