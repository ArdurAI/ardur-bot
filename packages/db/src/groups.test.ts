import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { IsolationError } from "./scope.js";

describe("listSpaceGroupsForSpaces", () => {
  it("loads and maps compact cross-space group fields", async () => {
    const findMany = vi.fn(async (_query: { where: unknown; select: Record<string, unknown> }) => [
      {
        id: "group-1",
        spaceId: "workspace-2",
        name: "Support crew",
        pinned: true,
        sectionId: null,
        updatedAt: new Date("2026-08-20T00:00:00.000Z"),
        thread: {
          unread: true,
          messages: [{ blocks: [{ kind: "text", text: "Escalation pending" }] }],
        },
        members: [
          { bot: { id: "bot-1", name: "Triage", color: "#111", runs: [] } },
          {
            bot: {
              id: "bot-2",
              name: "Responder",
              color: "#222",
              runs: [{ status: "running" }],
            },
          },
        ],
      },
    ]);
    const repos = createGroupRepos({ chatGroup: { findMany } } as unknown as PrismaClient);
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.test",
      isDeploymentOwner: false,
    };

    await expect(repos.listSpaceGroupsForSpaces(actor, ["workspace-2"])).resolves.toEqual([
      {
        id: "group-1",
        spaceId: "workspace-2",
        name: "Support crew",
        pinned: true,
        sectionId: null,
        members: [
          { botId: "bot-1", name: "Triage", color: "#111", status: "idle" },
          { botId: "bot-2", name: "Responder", color: "#222", status: "running" },
        ],
        preview: "Escalation pending",
        unread: true,
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    const query = findMany.mock.calls[0]![0];
    expect(query.select).not.toHaveProperty("userId");
    expect(query.select).not.toHaveProperty("archivedAt");
    expect(query.select).not.toHaveProperty("createdAt");
  });
});

describe("archiveGroup", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@example.com",
    isDeploymentOwner: true,
  };
  let queryRaw: ReturnType<typeof vi.fn>;
  let findFirst: ReturnType<typeof vi.fn>;
  let findManyRuns: ReturnType<typeof vi.fn>;
  let findManyComputers: ReturnType<typeof vi.fn>;
  let runUpdateMany: ReturnType<typeof vi.fn>;
  let attemptUpdateMany: ReturnType<typeof vi.fn>;
  let taskUpdateMany: ReturnType<typeof vi.fn>;
  let leaseUpdateMany: ReturnType<typeof vi.fn>;
  let leaseFindMany: ReturnType<typeof vi.fn>;
  let computerUpdateMany: ReturnType<typeof vi.fn>;
  let eventDeleteMany: ReturnType<typeof vi.fn>;
  let groupUpdate: ReturnType<typeof vi.fn>;
  let prisma: PrismaClient;

  beforeEach(() => {
    queryRaw = vi.fn().mockResolvedValue([{ id: "group-1" }]);
    findFirst = vi.fn().mockResolvedValue({ thread: { id: "thread-1" } });
    findManyRuns = vi.fn().mockResolvedValue([{ id: "run-1", taskId: "task-1" }]);
    findManyComputers = vi.fn().mockResolvedValue([
      {
        id: "computer-1",
        homeKey: "home-1",
        kind: "fake",
        providerRef: "computer-1",
        executionBotId: "bot-1",
        executionRunId: "run-1",
      },
    ]);
    runUpdateMany = vi.fn();
    attemptUpdateMany = vi.fn();
    taskUpdateMany = vi.fn();
    leaseUpdateMany = vi.fn();
    leaseFindMany = vi
      .fn()
      .mockResolvedValue([{ computerId: "computer-1", runId: "run-1", fence: 3 }]);
    computerUpdateMany = vi.fn();
    eventDeleteMany = vi.fn();
    groupUpdate = vi.fn();
    const tx = {
      $queryRaw: queryRaw,
      chatGroup: { findFirst, update: groupUpdate },
      run: { findMany: findManyRuns, updateMany: runUpdateMany },
      attempt: { updateMany: attemptUpdateMany },
      task: { updateMany: taskUpdateMany },
      computerExecutionLease: { findMany: leaseFindMany, updateMany: leaseUpdateMany },
      computer: { findMany: findManyComputers, updateMany: computerUpdateMany },
      event: { deleteMany: eventDeleteMany },
    };
    prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
    } as unknown as PrismaClient;
  });

  it("locks the group, archives it, and cancels only that thread's runs", async () => {
    const repos = createGroupRepos(prisma);

    await expect(repos.archiveGroup(actor, "group-1")).resolves.toEqual({
      cancelledRunIds: ["run-1"],
      computers: [
        {
          id: "computer-1",
          homeKey: "home-1",
          kind: "fake",
          providerRef: "computer-1",
          executionBotId: "bot-1",
          executionRunId: "run-1",
          executionFence: 3,
        },
      ],
    });

    expect(queryRaw).toHaveBeenCalled();
    expect(findManyRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ threadId: "thread-1" }),
      }),
    );
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "group-1",
          archivedAt: null,
        }),
      }),
    );
    expect(leaseUpdateMany).toHaveBeenCalledWith({
      where: { runId: { in: ["run-1"] } },
      data: { expiresAt: new Date(0) },
    });
    expect(computerUpdateMany).toHaveBeenCalledWith({
      where: { executionRunId: { in: ["run-1"] } },
      data: {
        executionRunId: null,
        executionBotId: null,
        executionLeaseExpiresAt: null,
      },
    });
    expect(groupUpdate).toHaveBeenCalledWith({
      where: { id: "group-1" },
      data: expect.objectContaining({ pinned: false, archivedAt: expect.any(Date) }),
    });
  });

  it("rejects when the group is already archived or missing", async () => {
    findFirst.mockResolvedValue(null);
    const repos = createGroupRepos(prisma);
    await expect(repos.archiveGroup(actor, "group-1")).rejects.toBeInstanceOf(IsolationError);
    expect(groupUpdate).not.toHaveBeenCalled();
  });
});

describe("updateGroup member removal", () => {
  it("marks a removed member's open ask round stopped instead of leaving it pending", async () => {
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@example.com",
      isDeploymentOwner: true,
    };
    const storedMessage = {
      id: "ask-message",
      botId: "chief",
      blocks: [
        {
          kind: "coordination",
          nonce: "group-ask:1:ask-run:call-1",
          round: 1,
          text: "Say hello.",
          updates: [],
          members: [
            { botId: "ada", name: "Ada", outcome: "answered" },
            { botId: "ben", name: "Ben", outcome: "pending" },
          ],
        },
      ],
    };
    const messageUpdate = vi.fn(
      async (_args: {
        data: { blocks: Array<{ members: Array<{ botId: string; outcome: string }> }> };
      }) => ({}),
    );
    const delegationUpdateMany = vi.fn(async () => ({ count: 0 }));
    const fullGroup = {
      id: "group-1",
      spaceId: "workspace-1",
      userId: "user-1",
      name: "Intro room",
      coordinatorBotId: "chief",
      pinned: false,
      sectionId: null,
      archivedAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      thread: { id: "thread-1", unread: false, messages: [] },
      members: [],
    };
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: "group-1" }]),
      botCommunicationPolicy: {
        upsert: vi.fn(async () => ({})),
        findMany: vi.fn(async () => [{ paused: false, enabled: true }]),
      },
      chatGroup: {
        findFirst: vi.fn(async () => ({
          id: "group-1",
          coordinatorBotId: "chief",
          members: [
            { botId: "chief", bot: { archivedAt: null } },
            { botId: "ada", bot: { archivedAt: null } },
            { botId: "ben", bot: { archivedAt: null } },
          ],
          thread: { id: "thread-1" },
        })),
        findFirstOrThrow: vi.fn(async () => fullGroup),
        update: vi.fn(async () => ({})),
      },
      chatGroupMember: {
        deleteMany: vi.fn(async () => ({ count: 1 })),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      botMessageDelivery: { findMany: vi.fn(async () => []) },
      run: {
        findMany: vi.fn(async () => [
          {
            id: "run-ben",
            taskId: "task-ben",
            delegationId: "delegation-ben",
            threadId: "thread-1",
            spaceId: "workspace-1",
          },
        ]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      attempt: { updateMany: vi.fn(async () => ({ count: 0 })) },
      task: { updateMany: vi.fn(async () => ({ count: 0 })) },
      delegation: {
        findMany: vi.fn(async () => [
          {
            id: "delegation-ben",
            actingBotId: "ben",
            actingName: "Ben",
            admissionKey: "group-ask:1:ask-run:call-1:ben",
          },
        ]),
        updateMany: delegationUpdateMany,
      },
      message: {
        findUnique: vi.fn(async () => storedMessage),
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
    const prisma = {
      $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx)),
      bot: {
        findMany: vi.fn(async () => [
          { id: "chief", name: "Chief", color: "#111" },
          { id: "ada", name: "Ada", color: "#222" },
        ]),
      },
    } as unknown as PrismaClient;

    const repos = createGroupRepos(prisma);
    const result = await repos.updateGroup(actor, {
      groupId: "group-1",
      botIds: ["chief", "ada"],
    });

    expect(result.cancelledRunIds).toEqual(["run-ben"]);
    const blocks = messageUpdate.mock.calls[0]?.[0].data.blocks;
    expect(blocks?.[0]?.members.find((row) => row.botId === "ben")?.outcome).toBe("stopped");
    expect(blocks?.[0]?.members.find((row) => row.botId === "ada")?.outcome).toBe("answered");
    // The delegation row stays unsettled so the fan-in settles silently and
    // never wakes the coordinator for an ask the person ended.
    expect(delegationUpdateMany).not.toHaveBeenCalled();
  });
});

describe("stable group memberships", () => {
  const actor = {
    spaceId: "space",
    userId: "user",
    email: "owner@example.test",
    isDeploymentOwner: true,
  };
  const now = new Date("2026-09-27T00:00:00.000Z");
  const pin = {
    runtimeKind: "pi",
    provider: "fixture",
    modelId: "fixture",
    effort: "low",
    credentialId: "connection",
    revision: 4,
  };
  const groupRecord = {
    id: "group",
    spaceId: "space",
    userId: "user",
    name: "Group",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
    thread: { id: "thread", unread: false, messages: [] },
    members: [
      { bot: { id: "bot-1", name: "One", color: "ink", runs: [] } },
      { bot: { id: "bot-2", name: "Two", color: "ink", runs: [] } },
    ],
  };

  it("deletes only removed members and creates only added members", async () => {
    const deleteMany = vi.fn();
    const createMany = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group" }]),
      spaceMember: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ organizationId: "org", space: { deletingAt: null } }),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          thread: { id: "thread" },
          coordinatorBotId: null,
          members: [
            {
              botId: "bot-1",
              bot: { archivedAt: null },
              id: "member-1",
              runtimePin: pin,
              modelPinRevision: 4,
            },
            { botId: "bot-2", bot: { archivedAt: null } },
            { botId: "bot-3", bot: { archivedAt: null } },
          ],
        }),
        update: vi.fn(),
        findFirstOrThrow: vi.fn().mockResolvedValue(groupRecord),
      },
      chatGroupMember: { deleteMany, createMany },
      run: { findMany: vi.fn().mockResolvedValue([]) },
      botCommunicationPolicy: { upsert: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      botMessageDelivery: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const prisma = {
      bot: {
        findMany: vi
          .fn()
          .mockResolvedValue(
            ["bot-1", "bot-2", "bot-4"].map((id) => ({ id, name: id, color: "ink" })),
          ),
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    await createGroupRepos(prisma).updateGroup(actor, {
      groupId: "group",
      botIds: ["bot-1", "bot-2", "bot-4"],
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { groupId: "group", botId: { in: ["bot-3"] } },
    });
    expect(createMany).toHaveBeenCalledWith({ data: [{ groupId: "group", botId: "bot-4" }] });
    expect(tx.run.findMany).toHaveBeenCalledWith({
      where: {
        threadId: "thread",
        botId: { in: ["bot-3"] },
        status: { in: ["queued", "leased", "running", "waiting_input", "waiting_takeover"] },
      },
      select: { id: true, taskId: true, delegationId: true, threadId: true, spaceId: true },
    });
  });

  it("copies explicit choices at initial revision one when duplicating", async () => {
    const createMany = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: "group" }]),
      spaceMember: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ organizationId: "org", space: { deletingAt: null } }),
      },
      chatGroup: {
        findFirst: vi.fn().mockResolvedValue({
          members: [
            { botId: "bot-1", runtimePin: pin, modelPinRevision: 4 },
            { botId: "bot-2", runtimePin: null, modelPinRevision: 0 },
          ],
        }),
        create: vi.fn().mockResolvedValue({ id: "new-group" }),
        findFirstOrThrow: vi.fn().mockResolvedValue(groupRecord),
      },
      chatGroupMember: { createMany },
      thread: { create: vi.fn() },
    };
    const prisma = {
      bot: {
        findMany: vi
          .fn()
          .mockResolvedValue(["bot-1", "bot-2"].map((id) => ({ id, name: id, color: "ink" }))),
      },
      $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaClient;
    await createGroupRepos(prisma).createGroup(actor, {
      name: "Copy",
      botIds: ["bot-1", "bot-2"],
      copyPinsFromGroupId: "group",
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          groupId: "new-group",
          botId: "bot-1",
          runtimePin: { ...pin, revision: 1 },
          modelPinRevision: 1,
        },
        { groupId: "new-group", botId: "bot-2" },
      ],
    });
  });
});
