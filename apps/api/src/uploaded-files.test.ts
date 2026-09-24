import type { ArtifactStore } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { IsolationError } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { deleteUploadedFile, listUploadedFiles } from "./uploaded-files.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const findMany = vi.fn(async () => [] as object[]);
  const findFirst = vi.fn(async () => ({ storageKey: "blob", spaceId: "space", botId: "bot" }));
  const deleteMany = vi.fn();
  const remove = vi.fn();
  return {
    findMany,
    findFirst,
    deleteMany,
    remove,
    deps: {
      prisma: { artifact: { findMany, findFirst, deleteMany } } as unknown as PrismaClient,
      artifacts: { remove } as unknown as ArtifactStore,
    },
  };
}
describe("uploaded files", () => {
  it("lists only uploads owned by the user in spaces they can still access", async () => {
    const f = fixture();
    f.findMany.mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => ({
        id: `file-${i}`,
        name: "notes.txt",
        size: 20,
        createdAt: new Date("2026-09-24T00:00:00Z"),
      })),
    );
    const page = await listUploadedFiles(f.deps.prisma, actor, "before");
    expect(page.items).toHaveLength(50);
    expect(page.cursor).toBe("file-49");
    expect(page.items[0]).toMatchObject({ size: 20, createdAt: "2026-09-24T00:00:00.000Z" });
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { lt: "before" },
          userId: "owner",
          runId: null,
          space: { memberships: { some: { userId: "owner" } } },
        },
        take: 51,
      }),
    );
  });
  it("rejects another user's file or generated artifact before touching storage", async () => {
    const f = fixture();
    f.findFirst.mockResolvedValue(null as never);
    await expect(deleteUploadedFile(f.deps, actor, "foreign")).rejects.toBeInstanceOf(
      IsolationError,
    );
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.deleteMany).not.toHaveBeenCalled();
    expect(f.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "foreign", userId: "owner", runId: null }),
      }),
    );
  });
  it("removes bytes before metadata and keeps failed removals retryable", async () => {
    const f = fixture();
    await deleteUploadedFile(f.deps, actor, "owned");
    expect(f.remove.mock.invocationCallOrder[0]).toBeLessThan(
      f.deleteMany.mock.invocationCallOrder[0]!,
    );
    f.deleteMany.mockClear();
    f.remove.mockRejectedValue(new Error("offline"));
    await expect(deleteUploadedFile(f.deps, actor, "owned")).rejects.toThrow("offline");
    expect(f.deleteMany).not.toHaveBeenCalled();
  });
});
