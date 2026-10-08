import { describe, expect, it, vi } from "vitest";
import { admitChiefAction, chiefExecutionRefusal, settleChiefAction } from "./chief-control.js";
import type { PrismaClient } from "./client.js";
import { requestSelectiveCancelInTransaction } from "./delegation.js";

function fixture() {
  const plan = { id: "plan", threadId: "room", revision: 1, control: null as unknown };
  const assignment = {
    runId: "run",
    memberId: "member",
    revision: 1,
    plan,
    coordinator: false,
    supersededAt: null as Date | null,
  };
  const run = {
    id: "run",
    status: "running",
    leaseFence: 4,
    cancelRequestedAt: null as Date | null,
    runtimePin: { runtimeKind: "pi" },
  };
  let intent: unknown;
  const locks: unknown[] = [];
  const tx = {
    $queryRaw: vi.fn(async (...args) => {
      locks.push(args);
    }),
    chiefAssignment: {
      findUnique: vi.fn(async () => assignment),
      findUniqueOrThrow: vi.fn(async () => assignment),
    },
    run: { findUnique: vi.fn(async () => run), findUniqueOrThrow: vi.fn(async () => run) },
    chiefActionAdmission: {
      findUnique: vi.fn(async () => intent),
      create: vi.fn(async ({ data }) => {
        intent = { ...data, id: "admission" };
        return intent;
      }),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (body) => body(tx)),
  } as unknown as PrismaClient;
  return { tx, prisma, assignment, plan, run, locks };
}
const call = {
  runId: "run",
  attempt: 4,
  executionId: "execution",
  consequential: true,
  remote: true,
};
const control = {
  revision: 2,
  ownerMessageIds: ["correction"],
  excludedIds: ["member"],
  localOnly: false,
  stopped: false,
  pendingReplan: true,
  stoppingRunIds: ["run"],
  uncertainRunIds: [],
};

describe("chief final tool admission fence", () => {
  it("records revision and owned in-flight intent under the room fence, rejects duplicate dispatch", async () => {
    const f = fixture();
    expect(await admitChiefAction(f.prisma, call)).toEqual({ admissionId: "admission" });
    expect(f.locks).toHaveLength(1);
    expect(f.tx.chiefActionAdmission.create).toHaveBeenCalledWith({
      data: { ...call, remote: undefined, revision: 1, effectId: undefined },
    });
    expect((await admitChiefAction(f.prisma, call)).error).toContain(
      "previous action may have finished",
    );
    expect(f.tx.chiefActionAdmission.create).toHaveBeenCalledTimes(1);
  });
  it("refuses the first subsequent old worker action after the correction, not just a steering row", async () => {
    const f = fixture();
    f.plan.control = control;
    f.plan.revision = 2;
    f.assignment.supersededAt = new Date();
    expect((await admitChiefAction(f.prisma, call)).error).toContain("stand down");
    expect(f.tx.chiefActionAdmission.create).not.toHaveBeenCalled();
  });
  it.each(["kept", "unknown"])(
    "refuses a replacement that repeats a %s effect, even with a new execution id",
    async (outcome) => {
      const f = fixture();
      f.plan.control = {
        ...control,
        revision: 1,
        pendingReplan: false,
        stoppingRunIds: [],
        excludedIds: [],
        reconciledActions: [{ runId: "old", effectId: "kept", outcome, revision: 1 }],
      };
      const effect = { kind: "fake-write", request: { target: "fake-page" } };
      Object.assign(f.tx, {
        externalEffect: {
          findUnique: vi.fn(async () => effect),
          findMany: vi.fn(async () => [effect]),
        },
      });
      expect(
        await admitChiefAction(f.prisma, {
          ...call,
          executionId: "replacement-effect",
          effectId: "new",
        }),
      ).toMatchObject({ error: expect.stringContaining("Do not repeat") });
      expect(f.tx.chiefActionAdmission.create).not.toHaveBeenCalled();
    },
  );
  it("refuses stale revision, lease and pending cancellation independently", async () => {
    const f = fixture();
    f.plan.revision = 2;
    expect(await chiefExecutionRefusal(f.prisma, "run")).toContain("revision");
    f.plan.revision = 1;
    f.run.leaseFence = 5;
    expect((await admitChiefAction(f.prisma, call)).error).toContain("lease");
    f.run.leaseFence = 4;
    f.run.cancelRequestedAt = new Date();
    expect((await admitChiefAction(f.prisma, call)).error).toContain("stand down");
  });
  it("fences local-only network calls and opaque shell while permitting a local artifact", async () => {
    const f = fixture();
    f.plan.control = { ...control, revision: 1, excludedIds: [], localOnly: true };
    expect(await chiefExecutionRefusal(f.prisma, "run", { remote: true })).toContain("local");
    expect(
      await chiefExecutionRefusal(f.prisma, "run", { consequential: true, tool: "shell" }),
    ).toContain("local");
    expect(
      await chiefExecutionRefusal(f.prisma, "run", { consequential: true, tool: "write_file" }),
    ).toBeUndefined();
  });
  it("uncertain prior effects block replacement writes, not independent reads; opaque runtimes fail closed", async () => {
    const f = fixture();
    f.plan.control = { ...control, revision: 1, excludedIds: [], uncertainRunIds: ["old"] };
    expect(await chiefExecutionRefusal(f.prisma, "run", { consequential: true })).toContain(
      "previous action",
    );
    expect(await chiefExecutionRefusal(f.prisma, "run", { consequential: false })).toBeUndefined();
    f.run.runtimePin.runtimeKind = "native";
    expect(await chiefExecutionRefusal(f.prisma, "run", { consequential: true })).toContain(
      "safely",
    );
  });
  it("settles only a still-admitted intent once and retains uncertain outcomes", async () => {
    const f = fixture();
    await settleChiefAction(f.prisma, "admission", true);
    expect(f.tx.chiefActionAdmission.updateMany).toHaveBeenCalledWith({
      where: { id: "admission", state: "admitted" },
      data: { state: "uncertain", settledAt: expect.any(Date) },
    });
  });
  it("selective stop scopes runs, approvals and helpers without touching a root or lease", async () => {
    const updateMany = () => vi.fn(async () => ({ count: 1 }));
    const tx = {
      run: {
        findMany: vi.fn(async () => [{ id: "run", delegationId: "delegation" }]),
        updateMany: updateMany(),
      },
      delegation: { updateMany: updateMany() },
      externalEffect: { updateMany: updateMany() },
      botMessageDelivery: { updateMany: updateMany() },
    };
    const correctionInput = {
      spaceId: "space",
      userId: "owner",
      plan: { id: "plan" },
      ownerMessageId: "message",
    };
    await requestSelectiveCancelInTransaction(tx as never, correctionInput, ["run"]);
    expect(tx.run.findMany).toHaveBeenCalledWith({
      where: { spaceId: "space", userId: "owner", id: { in: ["run"] } },
    });
    expect(tx.run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["run"] } }) }),
    );
    expect(tx.delegation.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ where: expect.objectContaining({ id: { in: ["delegation"] } }) }),
    );
    expect(tx.delegation.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ parentRunId: { in: ["run"] }, kind: "helper" }),
      }),
    );
    expect(tx.externalEffect.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runId: { in: ["run"] },
          status: { in: ["intended", "approved"] },
        }),
        data: { status: "denied" },
      }),
    );
  });
});
