import { groupAskKey, minimumDelegationReservation } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { finishDelegation } from "./delegation.js";
import { fixture } from "./delegation-test-fixture.js";
import {
  GROUP_ASK_EXPIRY_GRACE_MS,
  loadGroupAskResults,
  recordGroupAskOutcomeInTransaction,
  recordGroupAskUpdateInTransaction,
  recordStoppedGroupAskOutcomesInTransaction,
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
    /** A turn created before the last answer, then started after it. */
    coordinatorStartedAfter?: boolean;
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
    if ("startedAt" in where || "createdAt" in where) {
      if ("startedAt" in where && options.coordinatorStartedAfter) return { id: "started-after" };
      return options.coordinatorLater ? { id: "later" } : null;
    }
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

  it("does not wake again when a turn queued earlier starts after the last answer", async () => {
    const h = harness([member("ada", "completed", "completed")], {
      coordinatorStartedAfter: true,
    });
    await expect(wakeCoordinatorForGroupAsk(h.prisma, "delegation-ada", now)).resolves.toBeNull();
    expect(h.runCreate).not.toHaveBeenCalled();
    expect(h.rows.every((row) => row.coordinatorWokenAt === now)).toBe(true);
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
      message: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    } as unknown as PrismaClient;
    // Callers may hand over a whole run row; only its scope may reach the queries.
    const runRow = { ...scope, id: "wake-run", status: "running", runtimePin: { modelId: "m" } };
    await expect(loadGroupAskResults(prisma, runRow, ask)).resolves.toEqual({
      userRequest: "",
      results: [
        {
          id: "ada",
          name: "ADA",
          request: "Introduce yourself",
          outcome: "answered",
          text: null,
          posted: false,
        },
        {
          id: "ben",
          name: "BEN",
          request: "Introduce yourself",
          outcome: "failed",
          text: "Model missing",
          posted: false,
        },
      ],
    });
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...scope, id: "ask-run" } }),
    );
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

  it("carries the person's request and marks answers already posted in the room", async () => {
    const userRequest = "tell the bots to introduce each other, do not mention individually";
    const card = { goal: "Introduce yourself" };
    const members = [
      member("ada", "accepted", "completed", { card, result: "I research languages." }),
      member("ben", "failed", "failed", { card }),
    ];
    const prisma = {
      run: {
        findFirst: vi.fn(async () => ({
          taskId: "root",
          delegationRootTaskId: null,
          sourceMessageId: "person-message",
          threadId: "room",
        })),
        findMany: vi.fn(async () => members.map((entry) => entry.run)),
      },
      delegation: { findMany: vi.fn(async () => members.map((entry) => entry.row)) },
      message: {
        findFirst: vi.fn(async () => ({
          blocks: [{ kind: "text", text: userRequest }],
        })),
        findMany: vi.fn(async () => [{ runId: "run-ada" }]),
      },
    } as unknown as PrismaClient;
    const runRow = {
      ...scope,
      id: "wake-run",
      status: "running",
      clientNonce: "ask-wake:1:ask-run",
      taskId: "wake-task",
      runtimePin: { modelId: "m" },
    };
    await expect(loadGroupAskResults(prisma, runRow, ask)).resolves.toEqual({
      userRequest,
      results: [
        {
          id: "ada",
          name: "ADA",
          request: "Introduce yourself",
          outcome: "answered",
          text: null,
          posted: true,
        },
        {
          id: "ben",
          name: "BEN",
          request: "Introduce yourself",
          outcome: "failed",
          text: "Model missing",
          posted: false,
        },
      ],
    });
    expect(prisma.run.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...scope, id: "ask-run" } }),
    );
    expect(prisma.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "person-message", threadId: "room" },
      }),
    );
  });
});

describe("group ask budget", () => {
  // The one-request floor admission enforces for each member's own model, derived from the
  // shared constants: a full context plus one output at the model's effective cap.
  const standardFloor = minimumDelegationReservation();
  const reasoningFloor = minimumDelegationReservation({ reasoning: true });
  const askMember = (id: string, floor: number) => ({
    actingBotId: id,
    actingName: id,
    kind: "group-handoff" as const,
    admissionKey: groupAskKey(ask, "call", id),
    tokens: floor,
    minimumTokens: floor,
  });

  it("fits every other member of a full room inside the coordinator's task budget", async () => {
    const tight = fixture();
    const refused = await Promise.allSettled(
      ["a", "b", "c", "d", "e"].map((id) => tight.admit(askMember(id, standardFloor))),
    );
    const codes = refused.flatMap((result) =>
      result.status === "rejected" ? [result.reason.problem.code] : [],
    );
    // A default task root cannot hold a full room; the refusal is the room's budget, never
    // the member's own reservation, which already equals its floor.
    expect(codes).not.toHaveLength(0);
    expect(codes).not.toContain("budget-too-small");
    expect(codes).toContain("budget-exhausted");

    const sized = fixture();
    await sized.worker().$transaction((tx) =>
      sizeDelegationRootForAsk(tx, {
        runId: "parent",
        memberTokens: Array.from({ length: 5 }, () => standardFloor),
      }),
    );
    for (const id of ["a", "b", "c", "d", "e"]) await sized.admit(askMember(id, standardFloor));
    expect(sized.state().rows).toHaveLength(5);
    expect(sized.state().rows.every((row) => row.reservedTokens === standardFloor)).toBe(true);
    expect(sized.state().root).toMatchObject({
      maxConcurrent: 5,
      maxDescendants: 12,
      tokenLimit: 5 * standardFloor,
      reservedTokens: 5 * standardFloor,
    });
  });

  it("sizes the room to the sum of the members' floors, including a reasoning model's", async () => {
    const f = fixture();
    const floors = [standardFloor, standardFloor, reasoningFloor];
    await f
      .worker()
      .$transaction((tx) =>
        sizeDelegationRootForAsk(tx, { runId: "parent", memberTokens: floors }),
      );
    for (const [index, id] of ["a", "b", "c"].entries())
      await f.admit(askMember(id, floors[index]!));
    expect(f.state().rows.map((row) => row.reservedTokens)).toEqual(floors);
    expect(f.state().root).toMatchObject({
      tokenLimit: 2 * standardFloor + reasoningFloor,
      reservedTokens: 2 * standardFloor + reasoningFloor,
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
    await f.worker().$transaction((tx) =>
      sizeDelegationRootForAsk(tx, {
        runId: "parent",
        memberTokens: Array.from({ length: 5 }, () => standardFloor),
      }),
    );
    expect(f.state().root).toMatchObject({ maxConcurrent: 4, tokenLimit: 120_000 });
  });

  it("settles an asked member without a coordinator summary in the room", async () => {
    const f = fixture();
    const row = await f.admit(askMember("worker", standardFloor));
    await f
      .worker()
      .$transaction((tx) => finishDelegation(tx, row.id, "completed", "I am Worker."));
    expect(f.state().rows[0]).toMatchObject({ status: "completed", result: "I am Worker." });
    expect(f.state().messages).toEqual([]);
    expect(f.state().root).toMatchObject({ activeDescendants: 0 });
  });
});

describe("coordination round recording", () => {
  // Tool call ids from runtimes can contain colons (the scripted runtime uses
  // `<runId>:<tool>:<seq>`), so the round's message nonce is the admission key
  // minus its final member segment, not a fixed part count.
  const callId = "ask-run:ask_members:0";
  const coordinationMessage = {
    id: "ask-message",
    botId: "chief",
    blocks: [
      {
        kind: "coordination",
        nonce: `group-ask:1:ask-run:${callId}`,
        round: 1,
        text: "Say hello.",
        updates: [],
        members: [
          { botId: "ada", name: "Ada", outcome: "pending" },
          { botId: "ben", name: "Ben", outcome: "pending" },
        ],
      },
    ],
  };

  type RecordedBlocks = Array<{
    kind: string;
    updates?: string[];
    updatedAt?: string;
    members?: Array<Record<string, unknown>>;
  }>;

  function messageHarness(options: { message?: Record<string, unknown> | null } = {}) {
    const stored =
      options.message === undefined
        ? structuredClone(coordinationMessage)
        : options.message
          ? structuredClone(options.message)
          : null;
    const messageUpdate = vi.fn(async (_args: { data: { blocks: RecordedBlocks } }) => ({}));
    const eventCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "event",
      ...data,
    }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      message: {
        findUnique: vi.fn(async () => stored),
        findFirst: vi.fn(async () => stored),
        update: messageUpdate,
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 7 })) },
      event: { create: eventCreate },
    };
    return { tx, messageUpdate, eventCreate, stored };
  }

  const delegation = (patch: Record<string, unknown> = {}) => ({
    actingBotId: "ada",
    actingName: "Ada",
    admissionKey: groupAskKey(ask, callId, "ada"),
    ...patch,
  });

  it("marks a failed member with a reason code, never an English sentence or the raw error", async () => {
    const h = messageHarness();
    const recorded = await recordGroupAskOutcomeInTransaction(h.tx as never, {
      ...scope,
      threadId: "room",
      delegation: delegation(),
      delegationStatus: "failed",
      runStatus: "failed",
      error: "xai API error (403): You have run out of credits",
      providerErrorKind: "auth",
      now,
    });

    expect(recorded).toEqual({ threadId: "room", seq: 6 });
    const blocks = h.messageUpdate.mock.calls[0]?.[0].data.blocks;
    const ada = blocks?.[0]?.members?.find((row) => row.botId === "ada");
    expect(ada).toMatchObject({ outcome: "failed", reasonCode: "auth" });
    expect(ada?.reason).toBeUndefined();
    expect(JSON.stringify(blocks)).not.toContain("403");
    expect(JSON.stringify(blocks)).not.toContain("couldn't answer");
    expect(h.eventCreate.mock.calls[0]?.[0].data).toMatchObject({
      type: "thread.message.updated",
      botId: "chief",
      threadId: "room",
    });
  });

  it("stores the reason code classified from each providerErrorKind", async () => {
    const cases = [
      { providerErrorKind: "auth", error: "403", reasonCode: "auth" },
      { providerErrorKind: "rate-limit", error: "429", reasonCode: "rate-limit" },
      {
        providerErrorKind: "model-unavailable",
        error: "no such model",
        reasonCode: "model-unavailable",
      },
      { providerErrorKind: undefined, error: "boom", reasonCode: "other" },
    ] as const;
    for (const entry of cases) {
      const h = messageHarness();
      await recordGroupAskOutcomeInTransaction(h.tx as never, {
        ...scope,
        threadId: "room",
        delegation: delegation(),
        delegationStatus: "failed",
        runStatus: "failed",
        error: entry.error,
        providerErrorKind: entry.providerErrorKind,
        now,
      });
      const blocks = h.messageUpdate.mock.calls[0]?.[0].data.blocks;
      const ada = blocks?.[0]?.members?.find((row) => row.botId === "ada");
      expect(ada, entry.providerErrorKind ?? "no-kind").toMatchObject({
        outcome: "failed",
        reasonCode: entry.reasonCode,
      });
      expect(ada?.reason).toBeUndefined();
    }
  });

  it("marks answered, stopped and waiting members from their records", async () => {
    const cases = [
      { delegationStatus: "completed", runStatus: "completed", outcome: "answered" },
      { delegationStatus: "cancelled", runStatus: "cancelled", outcome: "stopped" },
      { delegationStatus: "running", runStatus: "waiting_input", outcome: "waiting" },
    ] as const;
    for (const entry of cases) {
      const h = messageHarness();
      await recordGroupAskOutcomeInTransaction(h.tx as never, {
        ...scope,
        threadId: "room",
        delegation: delegation(),
        delegationStatus: entry.delegationStatus,
        runStatus: entry.runStatus,
        now,
      });
      const blocks = h.messageUpdate.mock.calls[0]?.[0].data.blocks;
      expect(blocks?.[0]?.members?.find((row) => row.botId === "ada")?.outcome).toBe(entry.outcome);
    }
  });

  it("refuses a member id that contains a colon instead of mis-parsing the key", async () => {
    // Member ids are cuids, so this is a guard: a colon in the member segment
    // would shift the derived nonce away from the round's message, and the
    // lookup must miss cleanly rather than write to the wrong message.
    const realNonce = `group-ask:1:ask-run:${callId}`;
    const stored = structuredClone(coordinationMessage);
    const messageUpdate = vi.fn(async () => ({}));
    const tx = {
      message: {
        findUnique: vi.fn(
          async ({
            where,
          }: {
            where: { threadId_clientNonce: { threadId: string; clientNonce: string } };
          }) => (where.threadId_clientNonce.clientNonce === realNonce ? stored : null),
        ),
        findFirst: vi.fn(async () => null),
        update: messageUpdate,
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 7 })) },
      event: { create: vi.fn(async () => ({ id: "event" })) },
    };
    await expect(
      recordGroupAskOutcomeInTransaction(tx as never, {
        ...scope,
        threadId: "room",
        delegation: delegation({ admissionKey: groupAskKey(ask, callId, "ada:odd") }),
        delegationStatus: "completed",
        runStatus: "completed",
        now,
      }),
    ).resolves.toBeNull();
    expect(tx.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          threadId_clientNonce: {
            threadId: "room",
            clientNonce: `${realNonce}:ada`,
          },
        },
      }),
    );
    expect(messageUpdate).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
  });

  it("keeps the first terminal outcome and ignores delegations that are not asks", async () => {
    const settled = messageHarness({
      message: {
        ...coordinationMessage,
        blocks: [
          {
            ...coordinationMessage.blocks[0],
            members: [{ botId: "ada", name: "Ada", outcome: "answered" }],
          },
        ],
      },
    });
    await expect(
      recordGroupAskOutcomeInTransaction(settled.tx as never, {
        ...scope,
        threadId: "room",
        delegation: delegation(),
        delegationStatus: "failed",
        runStatus: "failed",
        now,
      }),
    ).resolves.toBeNull();
    expect(settled.messageUpdate).not.toHaveBeenCalled();

    const other = messageHarness();
    await expect(
      recordGroupAskOutcomeInTransaction(other.tx as never, {
        ...scope,
        threadId: "room",
        delegation: delegation({ admissionKey: "bot-message:1:ada" }),
        delegationStatus: "completed",
        runStatus: "completed",
        now,
      }),
    ).resolves.toBeNull();
    expect(other.messageUpdate).not.toHaveBeenCalled();
  });

  it("appends a progress note to the round, by exact nonce or by round prefix", async () => {
    const exact = messageHarness();
    const recorded = await recordGroupAskUpdateInTransaction(exact.tx as never, {
      ...scope,
      threadId: "room",
      nonce: "group-ask:1:ask-run:call-1",
      note: "Asked Ada and Ben.",
      now,
    });
    expect(recorded).toEqual({ threadId: "room", seq: 6 });
    expect(exact.stored && exact.messageUpdate).toBeTruthy();
    const blocks = exact.messageUpdate.mock.calls[0]?.[0].data.blocks;
    expect(blocks?.[0]?.updates).toEqual(["Asked Ada and Ben."]);
    expect(blocks?.[0]?.updatedAt).toBe(now.toISOString());

    // The wake turn knows only the round prefix; the latest matching message wins.
    const prefix = messageHarness();
    (prefix.tx.message.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await recordGroupAskUpdateInTransaction(prefix.tx as never, {
      ...scope,
      threadId: "room",
      nonce: "group-ask:1:ask-run:",
      note: "Two of three said hello.",
      now,
    });
    expect(prefix.tx.message.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "room", clientNonce: { startsWith: "group-ask:1:ask-run:" } },
      }),
    );
    const prefixBlocks = prefix.messageUpdate.mock.calls[0]?.[0].data.blocks;
    expect(prefixBlocks?.[0]?.updates).toEqual(["Two of three said hello."]);
  });

  it("settles a still-running member to stopped when the room's Stop cancels its run", async () => {
    // Stop cancels runs directly: no finalize settles the delegation, so the
    // round must learn the outcome here or the line pulses pending forever.
    const stored = structuredClone(coordinationMessage);
    const messageUpdate = vi.fn(
      async (_args: {
        data: { blocks: Array<{ members: Array<{ botId: string; outcome: string }> }> };
      }) => ({}),
    );
    const delegationUpdateMany = vi.fn(async () => ({ count: 0 }));
    const tx = {
      $queryRaw: vi.fn(async () => []),
      delegation: {
        findMany: vi.fn(async () => [
          {
            id: "delegation-ada",
            actingBotId: "ada",
            actingName: "Ada",
            admissionKey: groupAskKey(ask, callId, "ada"),
          },
        ]),
        updateMany: delegationUpdateMany,
      },
      message: {
        findUnique: vi.fn(async () => stored),
        findFirst: vi.fn(async () => stored),
        update: messageUpdate,
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 7 })) },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "event",
          ...data,
        })),
      },
    };

    await recordStoppedGroupAskOutcomesInTransaction(
      tx as never,
      [
        {
          delegationId: "delegation-ada",
          threadId: "room",
          spaceId: scope.spaceId,
        },
        // A coordinator run and a run with no delegation record nothing.
        { delegationId: null, threadId: "room", spaceId: scope.spaceId },
      ],
      now,
    );

    const blocks = messageUpdate.mock.calls[0]?.[0].data.blocks;
    expect(blocks?.[0]?.members?.find((row) => row.botId === "ada")?.outcome).toBe("stopped");
    expect(blocks?.[0]?.members?.find((row) => row.botId === "ben")?.outcome).toBe("pending");
    // The delegation row stays unsettled so the fan-in settles silently and
    // never wakes the coordinator for an ask the person ended.
    expect(delegationUpdateMany).not.toHaveBeenCalled();
  });

  it("keeps both changes when a fold and an outcome write the same round", async () => {
    // The fold locks the thread row before reading, the same lock the outcome
    // writers take, so the two writes serialize instead of last-writer-wins.
    const stored = structuredClone(coordinationMessage);
    const messageUpdate = vi.fn(async ({ data }: { data: { blocks: RecordedBlocks } }) => {
      stored.blocks = data.blocks as never;
    });
    const lock = vi.fn(async () => []);
    const findUnique = vi.fn(async () => stored);
    const tx = {
      $queryRaw: lock,
      message: {
        findUnique,
        findFirst: vi.fn(async () => stored),
        update: messageUpdate,
      },
      thread: { update: vi.fn(async () => ({ nextEventSeq: 7 })) },
      event: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "event",
          ...data,
        })),
      },
    };

    await recordGroupAskUpdateInTransaction(tx as never, {
      ...scope,
      threadId: "room",
      nonce: "group-ask:1:ask-run:call-1",
      note: "Asked Ada and Ben.",
      now,
    });
    await recordGroupAskOutcomeInTransaction(tx as never, {
      ...scope,
      threadId: "room",
      delegation: delegation(),
      delegationStatus: "completed",
      runStatus: "completed",
      now,
    });

    const block = stored.blocks[0] as RecordedBlocks[number];
    expect(block.updates).toEqual(["Asked Ada and Ben."]);
    expect(block.members?.find((row) => row.botId === "ada")?.outcome).toBe("answered");
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
      findUnique.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("records nothing when the round's message is gone", async () => {
    const h = messageHarness({ message: null });
    await expect(
      recordGroupAskUpdateInTransaction(h.tx as never, {
        ...scope,
        threadId: "room",
        nonce: "group-ask:1:ask-run:call-1",
        note: "note",
        now,
      }),
    ).resolves.toBeNull();
    expect(h.messageUpdate).not.toHaveBeenCalled();
    expect(h.eventCreate).not.toHaveBeenCalled();
  });
});
