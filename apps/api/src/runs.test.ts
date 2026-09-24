import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { activityNotificationsEnabled, activityPromptSnippet, listSpaceRuns } from "./runs.js";

it.each([null, "group"])(
  "routes delegated approvals to the scoped coordinator thread (%s)",
  async (groupId) => {
    const actor = { userId: "owner", spaceId: "space" } as Actor;
    const findRoots = vi.fn(async () => [
      {
        rootTaskId: "root",
        coordinatorBotId: "coordinator",
        coordinatorThreadId: "coordinator-thread",
      },
    ]);
    const findThreads = vi.fn(async () => [{ id: "coordinator-thread", groupId }]);
    const prisma = {
      run: {
        findMany: vi.fn(async () => [
          {
            id: "worker-run",
            botId: "worker",
            threadId: "worker-thread",
            taskId: "child",
            delegationId: "handoff",
            delegationRootTaskId: "root",
            status: "waiting_input",
            trigger: "bot_message",
            task: { prompt: "Review" },
            bot: { name: "Worker", notifyOnFinish: false },
            thread: { groupId: null },
            updatedAt: new Date("2026-09-24T00:00:00Z"),
          },
        ]),
      },
      delegation: { findMany: vi.fn(async () => []) },
      delegationRoot: { findMany: findRoots },
      thread: { findMany: findThreads },
    } as unknown as PrismaClient;
    const [run] = await listSpaceRuns(prisma, actor, "active");
    expect(run).toMatchObject({
      runId: "worker-run",
      threadId: "worker-thread",
      approvalTarget: {
        botId: "coordinator",
        threadId: "coordinator-thread",
        groupId,
      },
    });
    expect(findRoots).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...actor, rootTaskId: { in: ["root"] } } }),
    );
    expect(findThreads).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ...actor, id: { in: ["coordinator-thread"] } } }),
    );
  },
);

describe("run activity copy", () => {
  it("presents structured agent messages instead of their internal wake prompt", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] A message just arrived from another bot with internal routing data",
        sourceBlocks: [
          {
            kind: "bot_message_received",
            fromBotId: "maya",
            fromBotName: "Maya",
            text: "Please check the release workflow.",
            intent: "request",
          },
        ],
      }),
    ).toBe("Maya asked: Please check the release workflow.");
  });

  it("fails closed when an agent message has no valid structured source", () => {
    expect(
      activityPromptSnippet({
        trigger: "bot_message",
        prompt: "[bot] private internal routing envelope",
        sourceBlocks: [{ kind: "text", text: "not a peer message" }],
      }),
    ).toBe("Message from another agent");
  });
});

describe("run activity notification preference", () => {
  it("silences only direct messages", () => {
    expect(activityNotificationsEnabled(null, false)).toBe(false);
    expect(activityNotificationsEnabled("group-1", false)).toBe(true);
  });
});

it.each([false, true])(
  "keeps one tree stop target when the coordinator is visible: %s",
  async (includeCoordinator) => {
    const base = {
      botId: "worker",
      bot: { name: "Worker", notifyOnFinish: true },
      task: { prompt: "Review" },
      sourceMessage: null,
      threadId: "thread",
      thread: { groupId: null, externalConversationId: null, group: null },
      status: "running",
      trigger: "bot_message",
      updatedAt: new Date(),
      completedAt: null,
    };
    const worker = {
      ...base,
      id: "worker-run",
      taskId: "worker-task",
      delegationRootTaskId: "root",
      delegationId: "handoff",
    };
    const coordinator = {
      ...base,
      id: "coordinator-run",
      taskId: "root",
      delegationRootTaskId: null,
      delegationId: null,
    };
    const lineage = {
      id: "handoff",
      rootTaskId: "root",
      kind: "message",
      status: "running",
      reservedTokens: 10000,
      deadlineAt: new Date(Date.now() + 10000),
      createdAt: new Date(),
      snapshot: {
        pin: {
          provider: "scripted",
          modelId: "scripted",
          effort: "off",
          credentialId: "scripted",
          revision: 1,
        },
        computer: { id: "computer", mode: "team", kind: "test" },
        destination: { host: "localhost", local: true },
      },
      authority: { scopes: [], connectors: [] },
    };
    const prisma = {
      run: { findMany: vi.fn(async () => (includeCoordinator ? [worker, coordinator] : [worker])) },
      delegation: { findMany: vi.fn(async () => [lineage]) },
    } as unknown as PrismaClient;
    const rows = await listSpaceRuns(
      prisma,
      { userId: "owner", spaceId: "space" } as Actor,
      "active",
    );
    const trees = rows.filter((row) => row.delegations?.length);
    expect(trees).toHaveLength(1);
    expect(trees[0]).toMatchObject({
      runId: includeCoordinator ? "coordinator-run" : "worker-run",
      rootTaskId: "root",
      delegations: [{ id: "handoff" }],
    });
  },
);
