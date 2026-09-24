import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { getUserPreferences, updateUserPreferences } from "./preferences.js";

describe("per-user preference storage", () => {
  it("returns defaults without creating a row, then persists atomic partial updates", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const findUnique = vi.fn(
      async ({ where }: { where: { userId: string } }) => rows.get(where.userId) ?? null,
    );
    const upsert = vi.fn(
      async ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const row = { ...(rows.get(where.userId) ?? create), ...update };
        rows.set(where.userId, row);
        return row;
      },
    );
    const prisma = { userPreferences: { findUnique, upsert } } as unknown as PrismaClient;
    expect(await getUserPreferences(prisma, "first")).toEqual(DEFAULT_USER_PREFERENCES);
    expect(upsert).not.toHaveBeenCalled();
    await updateUserPreferences(prisma, "first", {
      theme: "dark",
      notifications: { routines: false },
    });
    await updateUserPreferences(prisma, "first", {
      chatFont: "serif",
      motion: "reduced",
      notifications: { approvalsNeeded: false },
    });
    expect(await getUserPreferences(prisma, "first")).toMatchObject({
      theme: "dark",
      chatFont: "serif",
      motion: "reduced",
      notifications: { routines: false, approvalsNeeded: false, dispatchMessages: true },
    });
    expect(await getUserPreferences(prisma, "second")).toEqual(DEFAULT_USER_PREFERENCES);
    expect(upsert.mock.calls[1]![0].update).toEqual({
      chatFont: "serif",
      motion: "reduced",
      approvalsNeeded: false,
    });
  });
});
