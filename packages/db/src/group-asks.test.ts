import { groupAskKey } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { finishDelegation } from "./delegation.js";
import { fixture } from "./delegation-test-fixture.js";
import {
  GROUP_ASK_EXPIRY_GRACE_MS,
  loadGroupAskResults,
  sizeDelegationRootForAsk,
  wakeCoordinatorForGroupAsk,
} from "./group-asks.js";

const ask = { round: 1, askRunId: "ask-run" };
const now = new Date("2026-09-28T12:00:00Z");
const scope = { spaceId: "space", userId: "owner" };

type Row = {
  id: string;
  rootTaskId: string;
  admissionKey: string;
  status: string;
  runId: string | null;
  actingBotId: string;
  actingName: string;
  result: string | null;
  card: unknown;
  createdAt: Date;
  completedAt: Date | null;
  deadlineAt: Date;
  coordinatorWokenAt: Date | null;
  spaceId: string;
  userId: string;
  summaryMessageId: null;
};

function member(
  id: string,
  status: string,
  runStatus: string,
  patch: Partial<Row> = {},
): { row: Row; run: { id: string; status: string; sourceMessageId: string } } {
  return {
    row: {
      id: `delegation-${id}`,
      rootTaskId: "root",
      admissionKey: groupAskKey(ask, "call-1", id),
      status,
      runId: `run-${id}`,
      actingBotId: id,
      actingName: id.toUpperCase(),
      result: status === "completed" ? `I am ${id}.` : status === "failed" ? "Model missing" : null,
      card: null,
      createdAt: new Date(now.getTime() - 10 * 60_000),
      completedAt: ["completed", "failed", "cancelled"].includes(status)
        ? new Date(now.getTime() - 60_000)
        : null,
      deadlineAt: new Date(now.getTime() + 30 * 60_000),
      coordinatorWokenAt: null,
      ...scope,
      summaryMessageId: null,
      ...patch,
    },
    run: { id: `run-${id}`, status: runStatus, sourceMessageId: "ask-message" },
  };
}

function harness(
  members: ReturnType<typeof member>[],
  options: {
    root?: Record<string, unknown>;
    paused?: boolean;
    group?: boolean;
    coordinatorActive?: boolean;
    coordinatorLater?: boolean;
  } = {},
) {
  const rows = members.map((entry) => entry.row);
  const runs = members.map((entry) => entry.run);
  const root = {
    rootTaskId: "root",
    coordinatorThreadId: "room",
    coordinatorBotId: "chief",
    cancelRequestedAt: null,
    ...scope,
    ...options.root,
  };
  const runCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "wake-run",
    ...data,
  }));
  const taskCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "wake-task",
    ...data,
  }));
  const coordinatorFindFirst = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    if ("createdAt" in where) return options.coordinatorLater ? { id: "later" } : null;
    return options.coordinatorActive ? { id: "busy" } : null;
  });
  const tx = {
    $queryRaw: vi.fn(async () => []),
    delegationRoot: {
      findUnique: vi.fn(async () => root),
      findUniqueOrThrow: vi.fn(async () => root),
      findFirstOrThrow: vi.fn(async () => root),
    },
    delegation: {
      findMany: vi.fn(async ({ where }: { where: { admissionKey: { startsWith: string } } }) =>
        rows.filter((row) => row.admissionKey.startsWith(where.admissionKey.startsWith)),
      ),
      findFirstOrThrow: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string | { in: string[] }; status?: string };
          data: Record<string, unknown>;
        }) => {
          let count = 0;
          for (const row of rows) {
            const ids = typeof where.id === "string" ? [where.id] : where.id.in;
            if (!ids.includes(row.id) || (where.status && row.status !== where.status)) continue;
            Object.assign(row, data);
            count++;
          }
          return { count };
        },
      ),
    },
    run: {
      findMany: vi.fn(async () => runs),
      findFirst: coordinatorFindFirst,
      create: runCreate,
    },
    task: { create: taskCreate },
    thread: { findUnique: vi.fn(async () => ({ groupId: "group" })) },
    chatGroup: {
      findFirst: vi.fn(async () => (options.group === false ? null : { id: "group" })),
    },
    botCommunicationPolicy: {
      findMany: vi.fn(async () => (options.paused ? [{ paused: true, enabled: true }] : [])),
    },
  };
  const prisma = {
    delegation: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id),
      ),
    },
    $transaction: vi.fn(async (operation: (client: typeof tx) => unknown) => operation(tx)),
  } as unknown as PrismaClient;
  return { prisma, rows, runCreate, taskCreate };
}

describe("group ask fan-in", () => {
  it("waits while any asked member is still working, then wakes the coordinator once", async () => {
    const members = [member("ada", "completed", "completed"), member("ben", "running", "running")];
    const h = harness(members);
    await expect(wakeCoordinatorForGroupAsk(h.prisma, "delegation-ada", now)).resolves.toBeNull();
    expect(h.runCreate).not.toHaveBeenCalled();

    Object.assign(members[1]!.row, { status: "completed", completedAt: now });
    members[1]!.run.status = "completed";
    await expect(wakeCoordinatorForGroupAsk(h.prisma, "delegation-ben", now)).resolves.toEqual({
      runId: "wake-run",
      threadId: "room",
    });
    expect(h.runCreate).toHaveBeenCalledOnce();
    expect(h.runCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        botId: "chief",
        threadId: "room",
        trigger: "follow_up",
        status: "queued",
        sourceMessageId: "ask-message",
        clientNonce: "ask-wake:1:ask-run",
      }),
    });
    expect(h.rows.map((row) => row.status)).toEqual(["accepted", "accepted"]);
    expect(h.rows.every((row) => row.coordinatorWokenAt === now)).toBe(true);

    await expect(wakeCoordinatorForGroupAsk(h.prisma, "delegation-ada", now)).resolves.toBeNull();
    expect(h.runCreate).toHaveBeenCalledOnce();
  });

  it("returns a failed member's failure with the others' answers", async () => {
    const h = harness([
      member("ada", "completed", "completed"),
      member("ben", "failed", "failed"),
      member("cy", "running", "waiting_input"),
    ]);
    await expect(
      wakeCoordinatorForGroupAsk(h.prisma, "delegation-ben", now),
    ).resolves.toMatchObject({
      runId: "wake-run",
    });
    expect(h.rows.map((row) => row.status)).toEqual(["accepted", "failed", "running"]);
  });

  it("wakes nobody after a stop, a pause, a changed coordinator or a coordinator that spoke again", async () => {
    const cases = [
      harness([member("ada", "completed", "completed")], { root: { cancelRequestedAt: now } }),
      harness([member("ada", "completed", "completed"), member("ben", "queued", "cancelled")]),
      harness([member("ada", "completed", "completed")], { paused: true }),
      harness([member("ada", "completed", "completed")], { group: false }),
      harness([member("ada", "completed", "completed")], { coordinatorLater: true }),
    ];
    for (const h of cases) {
      await expect(wakeCoordinatorForGroupAsk(h.prisma, "delegation-ada", now)).resolves.toBeNull();
      expect(h.runCreate).not.toHaveBeenCalled();
      expect(h.rows.every((row) => row.coordinatorWokenAt === now)).toBe(true);
    }
  });

  it("leaves the ask open while the coordinator is busy, and expires an ask that never settles", async () => {
    const busy = harness([member("ada", "completed", "completed")], { coordinatorActive: true });
    await expect(
      wakeCoordinatorForGroupAsk(busy.prisma, "delegation-ada", now),
    ).resolves.toBeNull();
    expect(busy.rows[0]!.coordinatorWokenAt).toBeNull();

    const past = { deadlineAt: new Date(now.getTime() - 60_000) };
    const stuck = harness([
      member("ada", "completed", "completed", past),
      member("ben", "queued", "queued", past),
    ]);
    await expect(
      wakeCoordinatorForGroupAsk(stuck.prisma, "delegation-ada", now),
    ).resolves.toBeNull();
    expect(stuck.rows[0]!.coordinatorWokenAt).toBeNull();
    const later = new Date(now.getTime() + GROUP_ASK_EXPIRY_GRACE_MS);
    await expect(
      wakeCoordinatorForGroupAsk(stuck.prisma, "delegation-ada", later),
    ).resolves.toBeNull();
    expect(stuck.rows.every((row) => row.coordinatorWokenAt === later)).toBe(true);
    expect(stuck.runCreate).not.toHaveBeenCalled();
  });

  it("ignores delegations that are not asks", async () => {
    const h = harness([
      member("ada", "completed", "completed", { admissionKey: "group-handoff:x" }),
    ]);
    await expect(wakeCoordinatorForGroupAsk(h.prisma, "delegation-ada", now)).resolves.toBeNull();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("loads each asked member's request and outcome for the follow-up turn", async () => {
    const card = { goal: "Introduce yourself" };
    const members = [
      member("ada", "accepted", "completed", { card }),
      member("ben", "failed", "failed", { card }),
    ];
    const prisma = {
      run: {
        findFirst: vi.fn(async () => ({ taskId: "root", delegationRootTaskId: null })),
        findMany: vi.fn(async () => members.map((entry) => entry.run)),
      },
      delegation: { findMany: vi.fn(async () => members.map((entry) => entry.row)) },
    } as unknown as PrismaClient;
    await expect(loadGroupAskResults(prisma, scope, ask)).resolves.toEqual([
      { id: "ada", name: "ADA", request: "Introduce yourself", outcome: "answered", text: null },
      {
        id: "ben",
        name: "BEN",
        request: "Introduce yourself",
        outcome: "failed",
        text: "Model missing",
      },
    ]);
    expect(prisma.delegation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          ...scope,
          rootTaskId: "root",
          admissionKey: { startsWith: "group-ask:1:ask-run:" },
        },
      }),
    );
  });
});

describe("group ask budget", () => {
  it("fits every other member of a full room inside the coordinator's task budget", async () => {
    const tight = fixture();
    const refused = await Promise.allSettled(
      ["a", "b", "c", "d", "e"].map((id) =>
        tight.admit({
          actingBotId: id,
          actingName: id,
          kind: "group-handoff",
          admissionKey: groupAskKey(ask, "call", id),
          tokens: 30_000,
        }),
      ),
    );
    expect(refused.filter((result) => result.status === "rejected")).not.toHaveLength(0);

    const sized = fixture();
    await sized
      .worker()
      .$transaction((tx) =>
        sizeDelegationRootForAsk(tx, { runId: "parent", members: 5, tokensPerMember: 30_000 }),
      );
    for (const id of ["a", "b", "c", "d", "e"])
      await sized.admit({
        actingBotId: id,
        actingName: id,
        kind: "group-handoff",
        admissionKey: groupAskKey(ask, "call", id),
        tokens: 30_000,
      });
    expect(sized.state().rows).toHaveLength(5);
    expect(sized.state().root).toMatchObject({
      maxConcurrent: 5,
      maxDescendants: 12,
      tokenLimit: 150_000,
      reservedTokens: 150_000,
    });
  });

  it("never raises a goal's owner-set budget", async () => {
    const f = fixture();
    f.tx.teamGoal.findUnique.mockResolvedValue({
      id: "goal",
      coordinatorBotId: "coordinator",
      threadId: "thread",
      untilAt: new Date(Date.now() + 3_600_000),
      maxDepth: 1,
      maxConcurrent: 4,
      maxHops: 6,
      maxDescendants: 12,
      tokenLimit: 120_000,
    } as never);
    await f
      .worker()
      .$transaction((tx) =>
        sizeDelegationRootForAsk(tx, { runId: "parent", members: 5, tokensPerMember: 30_000 }),
      );
    expect(f.state().root).toMatchObject({ maxConcurrent: 4, tokenLimit: 120_000 });
  });

  it("settles an asked member without a coordinator summary in the room", async () => {
    const f = fixture();
    const row = await f.admit({
      kind: "group-handoff",
      admissionKey: groupAskKey(ask, "call", "worker"),
      tokens: 30_000,
    });
    await f
      .worker()
      .$transaction((tx) => finishDelegation(tx, row.id, "completed", "I am Worker."));
    expect(f.state().rows[0]).toMatchObject({ status: "completed", result: "I am Worker." });
    expect(f.state().messages).toEqual([]);
    expect(f.state().root).toMatchObject({ activeDescendants: 0 });
  });
});
