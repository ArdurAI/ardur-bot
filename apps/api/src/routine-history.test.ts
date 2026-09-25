import type { Actor } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";
import { routineHistory } from "./routine-history.js";

it("loads failed Test run attempts, newest first, within the caller's routine and space", async () => {
  const date = new Date("2026-09-24T12:00:00Z");
  const findMany = vi.fn(async () => [
    { id: "attempt", status: "failed", createdAt: date, completedAt: date },
  ]);
  const findFirst = vi.fn(async () => ({ id: "routine" }) as { id: string } | null);
  const prisma = { routine: { findFirst }, run: { findMany } } as never;
  const actor = { userId: "user", spaceId: "space" } as Actor;
  expect(await routineHistory(prisma, actor, "routine")).toEqual([
    {
      id: "attempt",
      status: "failed",
      createdAt: date.toISOString(),
      completedAt: date.toISOString(),
    },
  ]);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { routineId: "routine", userId: "user", spaceId: "space" },
      take: 50,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  );
  findFirst.mockResolvedValue(null);
  findMany.mockClear();
  await expect(routineHistory(prisma, actor, "foreign-routine")).rejects.toThrow();
  expect(findMany).not.toHaveBeenCalled();
});
