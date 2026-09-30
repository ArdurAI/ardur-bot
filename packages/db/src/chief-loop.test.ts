import { describe, expect, it, vi } from "vitest";
import { loadChiefMemberFacts } from "./chief-loop.js";
import type { Prisma } from "./client.js";

describe("chief fact projection", () => {
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
