import type { Actor } from "@ardurbot/contracts";
import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { expect, it, vi } from "vitest";

vi.mock("@ardurbot/db", () => ({
  getUserPreferences: vi.fn(async () => DEFAULT_USER_PREFERENCES),
  createRepos: vi.fn(() => ({
    getBot: async () => ({
      name: "Helper",
      title: "",
      description: "",
      instructions: "",
      thread: { id: "thread" },
      computer: null,
    }),
  })),
}));
vi.mock("./thread-message-pages.js", () => ({ loadAllMessages: vi.fn(async () => []) }));

import { exportAccountData, exportBotData } from "./account-export.js";

const actor: Actor = {
  userId: "owner",
  spaceId: "first",
  email: "owner@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const date = new Date("2026-09-24T00:00:00Z");
  const user = {
    findUniqueOrThrow: vi.fn(async () => ({
      name: "Account",
      email: "owner@example.test",
      avatarStyle: "robot",
      createdAt: date,
    })),
  };
  const artifact = {
    findMany: vi.fn(async () => [
      {
        id: "upload",
        botId: null,
        groupId: null,
        runId: null,
        name: "notes.txt",
        mimeType: "text/plain",
        size: 5,
        storageKey: "private-storage-key",
        createdAt: date,
      },
    ]),
  };
  const bot = { findMany: vi.fn(async () => []) };
  const thread = { findMany: vi.fn(async () => [{ id: "thread" }]) };
  const spaceMember = {
    findMany: vi.fn(async () => [
      { space: { id: "first", name: "First" } },
      { space: { id: "second", name: "Second" } },
    ]),
  };
  const prisma = {
    user,
    artifact,
    bot,
    thread,
    spaceMember,
    routine: { findMany: vi.fn(async () => []) },
    usageRecord: { findMany: vi.fn(async () => [{ inputTokens: 1, createdAt: date }]) },
    feedback: { findMany: vi.fn(async () => []) },
    learningGrant: { findMany: vi.fn(async () => []) },
  };
  const deps = {
    prisma,
    memory: { read: async () => ({ documents: [{ path: "notes.md", content: "Remember" }] }) },
    memoryDocuments: { exportBundle: vi.fn(async () => ({ version: 1, documents: [] })) },
    artifacts: { get: vi.fn(async () => new TextEncoder().encode("hello")) },
    exportLearning: vi.fn(async () => ({ journey: [], observations: [] })),
  } as unknown as Parameters<typeof exportAccountData>[0];
  return { deps, prisma };
}
it("exports account data across current memberships, including uploaded bytes, without storage or authentication internals", async () => {
  const { deps, prisma } = fixture();
  const data = await exportAccountData(deps, actor);
  expect(data.spaces.map((space) => space.id)).toEqual(["first", "second"]);
  expect(data.spaces[0]?.uploads[0]).toMatchObject({
    contentBase64: "aGVsbG8=",
    createdAt: "2026-09-24T00:00:00.000Z",
    size: 5,
  });
  expect(data.preferences).toEqual(DEFAULT_USER_PREFERENCES);
  expect(JSON.stringify(data)).not.toContain("private-storage-key");
  expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
    where: { id: "owner" },
    select: { name: true, email: true, avatarStyle: true, createdAt: true },
  });
  expect(prisma.spaceMember.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { userId: "owner" } }),
  );
  for (const id of ["first", "second"]) {
    expect(prisma.bot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { spaceId: id, userId: "owner" } }),
    );
    expect(prisma.artifact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          spaceId: id,
          userId: "owner",
          runId: null,
          space: { memberships: { some: { userId: "owner" } } },
        },
      }),
    );
  }
});
it("keeps the existing bot export usable without a provisioned computer", async () => {
  const { deps } = fixture();
  const data = await exportBotData(deps, actor, "bot");
  expect(data.files).toEqual([]);
  expect(data.memory).toEqual([{ path: "notes.md", content: "Remember" }]);
  expect(data.learning).toEqual({ journey: [], observations: [] });
});
it("fails visibly instead of returning a silently incomplete export when an upload is unreadable", async () => {
  const { deps } = fixture();
  vi.mocked(deps.artifacts.get).mockRejectedValue(new Error("unreadable"));
  await expect(exportAccountData(deps, actor)).rejects.toThrow("unreadable");
});
