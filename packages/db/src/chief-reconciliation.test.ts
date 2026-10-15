import type { ChiefControl } from "@ardurbot/contracts";
import { ChiefControlSchema } from "@ardurbot/contracts";
import { CHIEF_RECONCILIATION_POLICY } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";
import {
  chiefExecutionRefusal,
  findChiefCorrectionPlan,
  reconcileChiefCorrection,
  recordChiefActionReconciliation,
} from "./chief-control.js";
import type { PrismaClient } from "./client.js";
import { appendEventInTransaction } from "./events.js";

vi.mock("./chief-loop.js", () => ({
  loadChiefMemberFacts: vi.fn(async () => [{ id: "chief", authorized: true }]),
}));
vi.mock("./events.js", () => ({
  appendEventInTransaction: vi.fn(async (_tx, input) => ({ ...input, seq: 1 })),
}));

function fixture() {
  const plan = {
    id: "plan",
    spaceId: "space",
    userId: "owner",
    threadId: "room",
    groupId: "group",
    chiefBotId: "chief",
    sourceRunId: "chief-run",
    sourceMessageId: "request",
    taskId: "task",
    revision: 2,
    operation: { taskType: "unknown", purpose: "general" },
    dispatch: null,
    updatedAt: new Date(),
    control: {
      revision: 2,
      ownerMessageIds: ["correction"],
      excludedIds: ["member"],
      localOnly: false,
      stopped: false,
      pendingReplan: true,
      stoppingRunIds: [],
      uncertainRunIds: ["old"],
      uncertaintySince: new Date().toISOString(),
    } as unknown,
  };
  const old = { id: "old", status: "cancelled", cancelConfirmedAt: new Date() };
  const chief = {
    id: "chief-run",
    botId: "chief",
    threadId: "room",
    status: "running",
    cancelRequestedAt: null,
    runtimePin: { runtimeKind: "pi" },
    leaseFence: 1,
  };
  const actions = [
    {
      runId: "old",
      consequential: true,
      effectId: "effect",
      executionId: "write",
      state: "uncertain",
    },
  ];
  const effects = [
    {
      id: "effect",
      runId: "old",
      spaceId: "space",
      kind: "fake-write",
      request: { destination: "fake-page" },
      status: "uncertain",
    },
  ];
  const assignment = {
    plan,
    planId: "plan",
    revision: 2,
    coordinator: true,
    supersededAt: null as Date | null,
    memberId: "chief",
  };
  const tx = {
    $queryRaw: vi.fn(async () => []),
    chiefPlan: {
      findUnique: vi.fn(async () => plan),
      findUniqueOrThrow: vi.fn(async () => plan),
      findMany: vi.fn(async () => [plan]),
      update: vi.fn(async ({ data }) => Object.assign(plan, data, { updatedAt: new Date() })),
    },
    chiefAssignment: {
      findUnique: vi.fn(async () => assignment),
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => assignment),
    },
    computerExecutionLease: { count: vi.fn(async () => 0) },
    run: {
      findUnique: vi.fn(async ({ where }) => (where.id === "old" ? old : chief)),
      findUniqueOrThrow: vi.fn(async () => chief),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }) => ({
        ...data,
        id: data.clientNonce.includes("reconcile") ? "check-run" : "replan-run",
      })),
    },
    chiefActionAdmission: {
      findMany: vi.fn(async () => actions),
      findFirst: vi.fn(async () => ({ state: "settled", tool: "read_file" })),
    },
    externalEffect: {
      findMany: vi.fn(async () => effects),
      findFirst: vi.fn(async () => effects[0]),
    },
    message: { findMany: vi.fn(async () => []) },
    task: {
      findUniqueOrThrow: vi.fn(async () => ({ id: "task", prompt: "Prepare only remaining work" })),
      update: vi.fn(async () => ({})),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (body) => body(tx)),
  } as unknown as PrismaClient;
  return { plan, old, chief, actions, effects, assignment, tx, prisma };
}

describe("chief correction reconciliation", () => {
  it.each(["cancelled", "missing"])(
    "anchors a %s unconfirmed stop without recorded effects and reconciles it once",
    async (status) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        const since = new Date();
        f.old.cancelConfirmedAt = null as never;
        if (status === "missing")
          f.tx.run.findUnique.mockImplementation(async ({ where }) =>
            where.id === "old" ? (null as never) : f.chief,
          );
        f.actions.length = 0;
        f.effects.length = 0;
        f.plan.control = {
          ...ChiefControlSchema.parse(f.plan.control),
          stoppingRunIds: ["old"],
          uncertainRunIds: [],
          uncertaintySince: undefined,
        };
        vi.mocked(appendEventInTransaction).mockClear();
        const polled: ChiefControl[] = [];
        for (const elapsed of [60_000, CHIEF_RECONCILIATION_POLICY.orphanOutcomeAfterMs - 1]) {
          vi.setSystemTime(since.getTime() + elapsed);
          expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
          polled.push(ChiefControlSchema.parse(f.plan.control));
          expect(f.plan.updatedAt.getTime()).toBe(since.getTime() + elapsed);
          expect(f.tx.run.create).not.toHaveBeenCalled();
        }
        vi.setSystemTime(since.getTime() + CHIEF_RECONCILIATION_POLICY.orphanOutcomeAfterMs);
        f.tx.computerExecutionLease.count.mockResolvedValue(1);
        expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
        expect(ChiefControlSchema.parse(f.plan.control).stoppingRunIds).toEqual(["old"]);
        expect(f.tx.run.create).not.toHaveBeenCalled();
        f.tx.computerExecutionLease.count.mockResolvedValue(0);
        expect(await reconcileChiefCorrection(f.prisma, "plan")).toMatchObject({
          runId: "replan-run",
        });
        for (const control of polled)
          expect(control).toMatchObject({
            stoppingRunIds: ["old"],
            uncertainRunIds: ["old"],
            uncertaintySince: since.toISOString(),
            pendingReplan: true,
          });
        const saved = ChiefControlSchema.parse(f.plan.control);
        expect(saved).toMatchObject({
          stoppingRunIds: [],
          uncertainRunIds: [],
          pendingReplan: false,
          reconciledActions: [{ runId: "old", effectId: null, revision: 2, outcome: "unknown" }],
        });
        expect(saved.reconciledActions).toHaveLength(1);
        expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
        expect(f.tx.run.create).toHaveBeenCalledOnce();
        expect(f.tx.run.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ clientNonce: "chief-replan:plan:2" }),
          }),
        );
        const events = vi.mocked(appendEventInTransaction).mock.calls.map(([, input]) => input);
        expect(events.filter((event) => event.payload.state === "reconciled")).toHaveLength(1);
        expect(events.filter((event) => event.payload.state === "replan")).toHaveLength(1);
        expect(f.old.cancelConfirmedAt).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["completed", "failed", "confirmed"])(
    "accepts existing %s stop evidence without introducing uncertainty",
    async (evidence) => {
      const f = fixture();
      if (evidence !== "confirmed") {
        f.old.status = evidence;
        f.old.cancelConfirmedAt = null as never;
      }
      f.actions.length = 0;
      f.effects.length = 0;
      f.plan.control = {
        ...ChiefControlSchema.parse(f.plan.control),
        stoppingRunIds: ["old"],
        uncertainRunIds: [],
        uncertaintySince: undefined,
      };
      expect(await reconcileChiefCorrection(f.prisma, "plan")).toMatchObject({
        runId: "replan-run",
      });
      expect(ChiefControlSchema.parse(f.plan.control)).toMatchObject({
        stoppingRunIds: [],
        uncertainRunIds: [],
        pendingReplan: false,
      });
      expect(ChiefControlSchema.parse(f.plan.control).reconciledActions).toBeUndefined();
      expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
      expect(f.tx.run.create).toHaveBeenCalledOnce();
    },
  );

  it("permits only the current chief's plan-local verification write during uncertainty", async () => {
    const f = fixture();
    f.plan.control = {
      ...ChiefControlSchema.parse(f.plan.control),
      reconciliationRunId: "chief-run",
    };
    expect(
      await chiefExecutionRefusal(f.prisma, "chief-run", {
        consequential: true,
        tool: "reconcile_chief_action",
      }),
    ).toBeUndefined();
    expect(
      await chiefExecutionRefusal(f.prisma, "chief-run", {
        consequential: true,
        tool: "write_file",
      }),
    ).toContain("previous action");
    expect(
      await chiefExecutionRefusal(f.prisma, "chief-run", {
        consequential: true,
        tool: "reconcile_chief_action",
        remote: true,
      }),
    ).toContain("current chief");
    f.assignment.coordinator = false;
    expect(
      await chiefExecutionRefusal(f.prisma, "chief-run", {
        consequential: true,
        tool: "reconcile_chief_action",
      }),
    ).toContain("current chief");
    f.assignment.coordinator = true;
    f.assignment.supersededAt = new Date();
    expect(
      await chiefExecutionRefusal(f.prisma, "chief-run", {
        consequential: true,
        tool: "reconcile_chief_action",
      }),
    ).toContain("stand down");
  });
  it.each([
    ["completed", "kept"],
    ["failed", "undone"],
    ["denied", "undone"],
  ])(
    "records a %s effect as %s, clears uncertainty and wakes replacement planning once",
    async (status, outcome) => {
      const f = fixture();
      f.effects[0]!.status = status;
      expect(await reconcileChiefCorrection(f.prisma, "plan")).toMatchObject({
        runId: "replan-run",
      });
      const saved = ChiefControlSchema.parse(f.plan.control);
      expect(saved.uncertainRunIds).toEqual([]);
      expect(saved.reconciledActions).toEqual([
        { runId: "old", effectId: "effect", revision: 2, outcome },
      ]);
      expect(saved.pendingReplan).toBe(false);
      expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
      expect(f.tx.run.create).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps an admitted call fenced even when its effect already has a receipt", async () => {
    const f = fixture();
    f.actions[0]!.state = "admitted";
    f.effects[0]!.status = "completed";
    await reconcileChiefCorrection(f.prisma, "plan");
    expect(ChiefControlSchema.parse(f.plan.control).uncertainRunIds).toEqual(["old"]);
    expect(f.tx.run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clientNonce: "chief-reconcile:plan:2" }),
      }),
    );
    expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
    expect(f.tx.run.create).toHaveBeenCalledTimes(1);
  });
  it("requires a scoped read-back, records once, then resumes after the checking turn finishes", async () => {
    const f = fixture();
    f.plan.control = {
      ...ChiefControlSchema.parse(f.plan.control),
      reconciliationRunId: "chief-run",
    };
    const input = { runId: "old", effectId: "effect", outcome: "kept" };
    f.tx.chiefActionAdmission.findFirst.mockResolvedValueOnce(null as never);
    expect(await recordChiefActionReconciliation(f.prisma, "chief-run", input)).toMatchObject({
      error: expect.stringContaining("Read back"),
    });
    expect(await recordChiefActionReconciliation(f.prisma, "chief-run", input)).toMatchObject({
      ok: true,
    });
    expect(await recordChiefActionReconciliation(f.prisma, "chief-run", input)).toEqual({
      ok: true,
    });
    expect(
      await recordChiefActionReconciliation(f.prisma, "chief-run", { ...input, outcome: "undone" }),
    ).toMatchObject({ error: expect.stringContaining("already") });
    f.tx.run.findFirst.mockResolvedValueOnce(f.chief as never);
    await reconcileChiefCorrection(f.prisma, "plan");
    expect(ChiefControlSchema.parse(f.plan.control).uncertainRunIds).toEqual([]);
    expect(f.tx.run.create).not.toHaveBeenCalled();
    expect(await reconcileChiefCorrection(f.prisma, "plan")).toMatchObject({ runId: "replan-run" });
    expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
  });
  it("refuses cross-effect records, executing effects and still-admitted calls", async () => {
    const f = fixture();
    f.plan.control = {
      ...ChiefControlSchema.parse(f.plan.control),
      reconciliationRunId: "chief-run",
    };
    const input = { runId: "old", effectId: "effect", outcome: "unknown" };
    f.tx.externalEffect.findFirst.mockResolvedValueOnce(null as never);
    expect(await recordChiefActionReconciliation(f.prisma, "chief-run", input)).toMatchObject({
      error: expect.stringContaining("does not belong"),
    });
    f.effects[0]!.status = "executing";
    expect(await recordChiefActionReconciliation(f.prisma, "chief-run", input)).toMatchObject({
      error: expect.stringContaining("in flight"),
    });
    f.actions[0]!.state = "admitted";
    expect(await recordChiefActionReconciliation(f.prisma, "chief-run", input)).toMatchObject({
      error: expect.stringContaining("in flight"),
    });
  });
  it("resolves a missing run at five minutes, but never while a lease is live", async () => {
    const f = fixture();
    f.tx.run.findUnique.mockResolvedValue(null as never);
    f.plan.control = {
      ...ChiefControlSchema.parse(f.plan.control),
      stoppingRunIds: ["old"],
      uncertaintySince: new Date(
        Date.now() - CHIEF_RECONCILIATION_POLICY.orphanOutcomeAfterMs + 10_000,
      ).toISOString(),
    };
    expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
    expect(ChiefControlSchema.parse(f.plan.control).uncertainRunIds).toEqual(["old"]);
    f.plan.control = {
      ...ChiefControlSchema.parse(f.plan.control),
      uncertaintySince: new Date(
        Date.now() - CHIEF_RECONCILIATION_POLICY.orphanOutcomeAfterMs - 1,
      ).toISOString(),
    };
    f.tx.computerExecutionLease.count.mockResolvedValueOnce(1);
    await reconcileChiefCorrection(f.prisma, "plan");
    expect(ChiefControlSchema.parse(f.plan.control).stoppingRunIds).toEqual(["old"]);
    await reconcileChiefCorrection(f.prisma, "plan");
    expect(ChiefControlSchema.parse(f.plan.control)).toMatchObject({
      uncertainRunIds: [],
      stoppingRunIds: [],
      reconciledActions: [{ runId: "old", effectId: "effect", revision: 2, outcome: "unknown" }],
    });
    expect(f.effects[0]!.status).toBe("uncertain");
  });
  it("does not make resolved inactive plans permanent correction candidates", async () => {
    const f = fixture();
    f.plan.control = {
      ...ChiefControlSchema.parse(f.plan.control),
      pendingReplan: false,
      stoppingRunIds: [],
      uncertainRunIds: [],
    };
    const scope = { spaceId: "space", userId: "owner", threadId: "room" };
    expect(await findChiefCorrectionPlan(f.prisma, scope)).toBeUndefined();
    f.tx.run.count.mockResolvedValueOnce(1);
    expect(await findChiefCorrectionPlan(f.prisma, scope)).toBe(f.plan);
    expect(f.tx.chiefPlan.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: scope }));
  });
  it.each([false, true])(
    "bounds an unconfirmed cancelled run with a pending effect (live lease: %s)",
    async (live) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        f.old.cancelConfirmedAt = null as never;
        f.actions[0]!.state = "admitted";
        f.effects[0]!.status = "executing";
        const since = new Date();
        f.plan.control = {
          ...ChiefControlSchema.parse(f.plan.control),
          stoppingRunIds: ["old"],
          uncertaintySince: since.toISOString(),
        };
        f.tx.computerExecutionLease.count.mockResolvedValue(live ? 1 : 0);
        vi.setSystemTime(since.getTime() + CHIEF_RECONCILIATION_POLICY.orphanOutcomeAfterMs - 1);
        expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
        expect(ChiefControlSchema.parse(f.plan.control).stoppingRunIds).toEqual(["old"]);
        vi.setSystemTime(since.getTime() + CHIEF_RECONCILIATION_POLICY.orphanOutcomeAfterMs);
        await reconcileChiefCorrection(f.prisma, "plan");
        if (live) {
          expect(ChiefControlSchema.parse(f.plan.control).stoppingRunIds).toEqual(["old"]);
          expect(f.tx.run.create).not.toHaveBeenCalled();
        } else {
          expect(ChiefControlSchema.parse(f.plan.control)).toMatchObject({
            stoppingRunIds: [],
            uncertainRunIds: [],
            pendingReplan: false,
            reconciledActions: [
              { runId: "old", effectId: "effect", revision: 2, outcome: "unknown" },
            ],
          });
          expect(f.effects[0]!.status).toBe("executing");
          expect(await reconcileChiefCorrection(f.prisma, "plan")).toBeUndefined();
          expect(f.tx.run.create).toHaveBeenCalledOnce();
          // A late receipt cannot turn an earlier unknown outcome into permission to repeat it.
          f.effects[0]!.status = "completed";
          await reconcileChiefCorrection(f.prisma, "plan");
          expect(ChiefControlSchema.parse(f.plan.control).reconciledActions?.[0]?.outcome).toBe(
            "unknown",
          );
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
