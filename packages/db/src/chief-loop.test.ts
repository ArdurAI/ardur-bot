import { describe, expect, it, vi } from "vitest";
import { loadChiefMemberFacts, validateChiefDispatch } from "./chief-loop.js";
import type { Prisma } from "./client.js";

describe("chief fact projection", () => {
  it("retains ordinary handoff boot admission without granting unverified preparation", async () => {
    const plan = {
      id: "plan",
      sourceMessageId: "request",
      revision: 1,
      control: null,
      operation: { purpose: "general", taskType: "unknown" },
      decision: { kind: "plan" },
      checkedFacts: [],
    };
    const tx = {
      chiefPlan: { findFirst: vi.fn(async () => plan) },
      bot: {
        findMany: vi.fn(async () => [
          {
            id: "member",
            name: "Renamed",
            title: "Writer",
            runtimeKind: "pi",
            modelId: "model",
            thinkingLevel: "high",
            modelPinRevision: 1,
            concurrentRuns: 1,
            space: { concurrentRuns: 1 },
            computer: null,
            taughtSkills: [],
            groupMembers: [{ createdAt: new Date(0), modelPinRevision: 1, runtimePin: null }],
          },
        ]),
      },
      run: { findMany: vi.fn(async () => []) },
      mcpServer: { findMany: vi.fn(async () => []) },
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      botBrief: { findMany: vi.fn(async () => []) },
    };
    const scope = {
      spaceId: "space",
      userId: "owner",
      id: "run",
      botId: "chief",
      threadId: "thread",
    };
    const db = tx as unknown as Prisma.TransactionClient;
    expect(await validateChiefDispatch(db, scope, "room", "member")).toMatchObject({
      planId: "plan",
      dispatch: { memberId: "member", state: "messaged" },
    });
    tx.chiefPlan.findFirst.mockResolvedValue({
      ...plan,
      operation: { taskType: "operations", purpose: "install-tool" },
      decision: { kind: "delegate", memberId: "member" },
    } as typeof plan);
    expect(await validateChiefDispatch(db, scope, "room", "member")).toMatchObject({
      error: expect.stringContaining("no longer eligible"),
    });
    tx.bot.findMany.mockResolvedValue([]);
    tx.chiefPlan.findFirst.mockResolvedValue(plan);
    expect(await validateChiefDispatch(db, scope, "room", "member")).toMatchObject({
      error: expect.stringContaining("no longer an authorized"),
    });
  });
  it("projects only authorized scope keys even when passed a run or plan object", async () => {
    const tx = {
      bot: { findMany: vi.fn(async () => []) },
      run: { findMany: vi.fn(async () => []) },
      mcpServer: { findMany: vi.fn(async () => []) },
      computerExecutionLease: { findMany: vi.fn(async () => []) },
      botBrief: { findMany: vi.fn(async () => []) },
    };
    const plan = {
      spaceId: "space",
      userId: "owner",
      groupId: "room",
      sourceRunId: "run",
      taskId: "task",
      operation: { purpose: "general" },
    };
    expect(
      await loadChiefMemberFacts(tx as unknown as Prisma.TransactionClient, plan, "room"),
    ).toEqual([]);
    const query = tx.bot.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(query[0].where).toEqual({
      spaceId: "space",
      userId: "owner",
      archivedAt: null,
      groupMembers: {
        some: { groupId: "room", group: { spaceId: "space", userId: "owner", archivedAt: null } },
      },
    });
  });
});
