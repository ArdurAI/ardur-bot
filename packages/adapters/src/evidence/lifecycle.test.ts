import type { BackgroundJob, JobPublisher } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { confirmDispatchStop, finalizeRun } from "@ardurbot/db";
import { verifySeal } from "@ardurbot/evidence";
import { describe, expect, it, vi } from "vitest";
import { createBackgroundJobHandlers } from "../background-job-handlers.js";
import { EncryptedSecretStore } from "../secrets.js";
import { createEvidenceRecorder } from "./recorder.js";
import { createEvidenceSealRecovery } from "./recovery.js";
import { fakeEvidenceStore } from "./test-store.js";

function fixture() {
  const evidence = fakeEvidenceStore();
  const recorder = createEvidenceRecorder({
    store: evidence.store,
    secretStore: new EncryptedSecretStore("test-only-encryption-key"),
  });
  const run = {
    id: "run-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    status: "running",
    cancelRequestedAt: null as Date | null,
    sourceMessage: null,
    delegationRootTaskId: null,
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    run: {
      findUnique: vi.fn(async () => run),
      findMany: vi.fn(async () => []),
      findUniqueOrThrow: vi.fn(async () => run),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      updateMany: vi.fn(async ({ data }: { data: { status?: string } }) => {
        if (run.status !== "running") return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      }),
    },
    attempt: { updateMany: vi.fn(async () => ({ count: 1 })) },
    task: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn(async () => ({})) },
    thread: { update: vi.fn(async () => ({ nextEventSeq: 1 })) },
    event: {
      create: vi.fn(async () => ({ threadId: run.threadId, seq: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    steeringMessage: {
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    botMessageWake: { findMany: vi.fn(async () => []) },
    botMessageDelivery: {
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
    bot: { update: vi.fn(async () => ({})) },
    delegation: { findMany: vi.fn(async () => []) },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  } as unknown as PrismaClient;
  const queued: BackgroundJob[] = [];
  const jobs = {
    enqueue: vi.fn(async (job: BackgroundJob) => {
      queued.push(job);
    }),
  } as unknown as JobPublisher;
  const handlers = createBackgroundJobHandlers({
    executor: { sealRunEvidence: recorder.sealRunEvidence },
    prisma,
    jobs,
  } as unknown as Parameters<typeof createBackgroundJobHandlers>[0]);
  return { ...evidence, recorder, run, prisma, jobs, queued, handlers };
}

async function record(f: ReturnType<typeof fixture>) {
  expect(
    await f.recorder.recordDecision({
      run: f.run,
      toolName: "read_file",
      viaConnector: false,
      args: { path: "example.txt" },
      decisionKind: "allowed_by_default",
    }),
  ).toEqual({ ok: true });
}
async function drain(f: ReturnType<typeof fixture>) {
  for (const job of f.queued)
    if (job.name === "evidence.seal") await f.handlers["evidence.seal"](job.payload);
}

describe("terminal-run evidence jobs", () => {
  it.each(["completed", "failed"] as const)(
    "%s enqueues and seals the durable head once",
    async (outcome) => {
      const f = fixture();
      await record(f);
      const input = {
        spaceId: f.run.spaceId,
        threadId: f.run.threadId,
        botId: f.run.botId,
        runId: f.run.id,
        taskId: f.run.taskId,
        attemptId: "attempt-1",
        leaseOwner: "worker-1",
        leaseFence: 1,
        outcome,
        blocks: [],
        error: "fixture failure",
      };
      expect(await finalizeRun(f.prisma, input, undefined, f.jobs)).not.toBe(false);
      expect(f.queued).toEqual([
        { name: "evidence.seal", payload: { runId: f.run.id }, replaceKey: f.run.id },
      ]);
      await drain(f);
      await drain(f);
      expect(f.seals).toHaveLength(1);
      expect(f.seals[0]?.headSha256).toBe(f.records.at(-1)?.sha256);
      expect(
        verifySeal(
          f.seals[0]!.jws,
          f.records.map((row) => row.jws),
          f.keys[0]!.publicKeyPem,
        ).ok,
      ).toBe(true);
    },
  );
  it("confirmed cancellation enqueues and seals too; a second confirmation does nothing", async () => {
    const f = fixture();
    await record(f);
    f.run.cancelRequestedAt = new Date();
    expect(await confirmDispatchStop(f.prisma, f.run.id, undefined, f.jobs)).toBe(true);
    expect(await confirmDispatchStop(f.prisma, f.run.id, undefined, f.jobs)).toBe(false);
    expect(f.queued).toHaveLength(1);
    await drain(f);
    expect(f.seals).toHaveLength(1);
    expect(
      verifySeal(
        f.seals[0]!.jws,
        f.records.map((row) => row.jws),
        f.keys[0]!.publicKeyPem,
      ).ok,
    ).toBe(true);
  });
  it("does not create a seal or key for an empty run", async () => {
    const f = fixture();
    await f.handlers["evidence.seal"]({ runId: f.run.id });
    expect(f.seals).toEqual([]);
    expect(f.keys).toEqual([]);
  });
  it("requests a job retry on storage failure", async () => {
    const f = fixture();
    await record(f);
    f.store.recordsForRun = async () => {
      throw new Error("Storage unavailable");
    };
    await expect(f.handlers["evidence.seal"]({ runId: f.run.id })).rejects.toThrow(
      "Evidence sealing failed",
    );
    expect(f.seals).toEqual([]);
  });
  it("leaves invalid evidence unsealed without retrying the same job", async () => {
    const f = fixture();
    await record(f);
    f.records[0]!.jws = "corrupted";
    await expect(f.handlers["evidence.seal"]({ runId: f.run.id })).resolves.toBeUndefined();
    expect(f.seals).toEqual([]);
  });
  it("recovers cancellation after its post-commit enqueue fails", async () => {
    const f = fixture();
    await record(f);
    f.run.cancelRequestedAt = new Date();
    vi.mocked(f.jobs.enqueue).mockRejectedValueOnce(new Error("Queue unavailable"));
    expect(await confirmDispatchStop(f.prisma, f.run.id, undefined, f.jobs)).toBe(true);
    expect(f.run.status).toBe("cancelled");
    expect(f.queued).toEqual([]);
    const recover = createEvidenceSealRecovery({
      prisma: {
        $queryRaw: vi.fn(async () => [{ id: f.records[0]!.id, runId: f.run.id }]),
      } as unknown as PrismaClient,
      jobs: f.jobs,
    });
    await recover();
    await drain(f);
    expect(f.seals).toHaveLength(1);
  });
  it("recovers lost enqueue work with a bounded paginated scan", async () => {
    const enqueue = vi.fn(async () => undefined);
    const query = vi
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, i) => ({ id: `record-${i}`, runId: `run-${i}` })),
      )
      .mockResolvedValueOnce([]);
    const recover = createEvidenceSealRecovery({
      prisma: { $queryRaw: query } as unknown as PrismaClient,
      jobs: { enqueue } as unknown as JobPublisher,
    });
    await recover();
    await recover();
    expect(enqueue).toHaveBeenCalledTimes(100);
    expect(query.mock.calls[1]).toContain("record-99");
    query.mockResolvedValueOnce([]);
    await recover();
    expect(query.mock.calls[2]).toContain("");
  });
});
