import type { ArtifactStore } from "@ardurbot/adapter-kit";
import type { Actor } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { getSpaceArtifact } from "./artifacts.js";

const actor: Actor = {
  userId: "owner-1",
  spaceId: "space-1",
  email: "owner@example.test",
  isDeploymentOwner: true,
};

function fixture() {
  const rows: Record<string, Record<string, unknown>> = {
    "group-artifact": {
      id: "group-artifact",
      botId: "bot-1",
      groupId: "group-1",
      runId: null,
      storageKey: "key-group",
      name: "group.md",
      mimeType: "text/markdown",
      size: 3,
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    },
    "ungrouped-artifact": {
      id: "ungrouped-artifact",
      botId: "bot-1",
      groupId: null,
      runId: null,
      storageKey: "key-ungrouped",
      name: "own.md",
      mimeType: "text/markdown",
      size: 3,
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
    },
  };
  const prisma = {
    artifact: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = rows[where.id as string];
        if (!row) return null;
        // The query is the scope rule: group artifact or the owner's ungrouped one.
        const groupIds = (where.OR as { groupId: string | null }[] | undefined)?.map(
          (clause) => clause.groupId,
        );
        if (!groupIds?.includes(row.groupId as string | null)) return null;
        return row;
      }),
    },
  } as unknown as PrismaClient;
  const store = {
    get: vi.fn(async (storageKey: string) => {
      if (storageKey === "key-group") return new Uint8Array([1, 2, 3]);
      if (storageKey === "key-ungrouped") return new Uint8Array([4, 5]);
      throw new Error(`unexpected storage key ${storageKey}`);
    }),
  } as unknown as ArtifactStore;
  return { prisma, store };
}

describe("getSpaceArtifact", () => {
  it("opens the goal group's artifact through the group scope", async () => {
    const f = fixture();
    const artifact = await getSpaceArtifact({ prisma: f.prisma, artifacts: f.store }, actor, {
      artifactId: "group-artifact",
      groupId: "group-1",
      contextBotId: "bot-1",
    });
    expect(artifact.contentBase64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    expect(artifact.groupId).toBe("group-1");
  });

  it("opens the owner's ungrouped artifact through the same group scope", async () => {
    const f = fixture();
    const artifact = await getSpaceArtifact({ prisma: f.prisma, artifacts: f.store }, actor, {
      artifactId: "ungrouped-artifact",
      groupId: "group-1",
      contextBotId: "bot-1",
    });
    expect(artifact.contentBase64).toBe(Buffer.from([4, 5]).toString("base64"));
    expect(artifact.groupId).toBeNull();
  });

  it("applies the same query shape for every read", async () => {
    const f = fixture();
    await getSpaceArtifact({ prisma: f.prisma, artifacts: f.store }, actor, {
      artifactId: "group-artifact",
      groupId: "group-1",
      contextBotId: "bot-1",
    });
    expect(f.prisma.artifact.findFirst).toHaveBeenCalledWith({
      where: {
        id: "group-artifact",
        spaceId: actor.spaceId,
        userId: actor.userId,
        OR: [{ groupId: "group-1" }, { groupId: null }],
      },
    });
  });
});
