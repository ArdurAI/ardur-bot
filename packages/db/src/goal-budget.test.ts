import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { getGoal } from "./goals.js";

const now = new Date("2030-01-01T00:00:00Z");
const row = {
  id: "goal-budget",
  spaceId: "space",
  userId: "owner",
  groupId: "group",
  threadId: "thread",
  coordinatorBotId: "coordinator",
  rootTaskId: "root",
  objective: "Review",
  doneWhen: [],
  status: "stopped",
  tokenLimit: 100,
  perWorkerTokens: 65_536,
  maxConcurrent: 2,
  maxDescendants: 60,
  untilAt: now,
  createdAt: now,
  stoppedAt: now,
  // The goal query loads the latest submitted revision with the row.
  revisions: [],
};
function snapshot(
  root: { usedTokens: number; reservedTokens: number; tokenLimit: number } | null,
  incomplete = false,
  unmeasured = false,
) {
  const tx = {
    teamGoal: { findFirst: vi.fn(async () => row) },
    delegationRoot: { findFirst: vi.fn(async () => root) },
    usageRecord: { findFirst: vi.fn(async () => (incomplete ? { id: "partial" } : null)) },
    run: { findFirst: vi.fn(async () => (unmeasured ? { id: "unmeasured" } : null)) },
  };
  const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  return { tx, transaction, prisma: { $transaction: transaction } as unknown as PrismaClient };
}
const actor = { spaceId: "space", userId: "owner" } as never;

describe("goal budget snapshot", () => {
  it("reads ledger and completeness in one repeatable-read transaction under the goal scope", async () => {
    const f = snapshot({ usedTokens: 10, reservedTokens: 20, tokenLimit: 90 });
    expect(await getGoal(f.prisma, actor, "group")).toMatchObject({
      usedTokens: 10,
      reservedTokens: 20,
      availableTokens: 60,
      usageComplete: true,
    });
    expect(f.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    for (const delegate of [f.tx.teamGoal, f.tx.delegationRoot, f.tx.usageRecord, f.tx.run]) {
      expect(delegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ spaceId: "space", userId: "owner" }),
        }),
      );
    }
  });
  it.each([
    [true, false],
    [false, true],
  ])("marks incomplete and absent provider measurements", async (partial, missing) => {
    const f = snapshot({ usedTokens: 0, reservedTokens: 20, tokenLimit: 100 }, partial, missing);
    expect(await getGoal(f.prisma, actor, "group")).toMatchObject({
      usageComplete: false,
      reservedTokens: 20,
    });
  });
  it("does not invent an unused budget when the root is missing", async () => {
    const f = snapshot(null);
    expect(await getGoal(f.prisma, actor, "group")).toMatchObject({
      usedTokens: null,
      reservedTokens: null,
      availableTokens: null,
      usageComplete: false,
    });
  });
});
