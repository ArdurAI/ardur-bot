import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Actor } from "@ardurbot/contracts";
import { DEFAULT_USER_PREFERENCES } from "@ardurbot/contracts";
import { createRepos } from "@ardurbot/db";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { LocalAgentHomeStore } from "../../../packages/adapters/src/home.js";

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

import {
  exportAccountData,
  exportArchive,
  exportBotData,
  mountExportRoutes,
} from "./account-export.js";

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
it("exports account data across current memberships, including upload references, without storage or authentication internals", async () => {
  const { deps, prisma } = fixture();
  const data = await exportAccountData(deps, actor);
  expect(data.spaces.map((space) => space.id)).toEqual(["first", "second"]);
  expect(data.spaces[0]?.uploads[0]).toMatchObject({
    archivePath: "uploads/1",
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
  expect(data.home).toBeNull();
  expect(data.memory).toEqual([{ path: "notes.md", content: "Remember" }]);
  expect(data.learning).toEqual({ journey: [], observations: [] });
});

it("streams one shared home, preserves binary hashes, omits caches and profiles, and stays within export budgets", async () => {
  const { deps, prisma } = fixture();
  const root = await mkdtemp(path.join(tmpdir(), "export-test-"));
  const home = new LocalAgentHomeStore(root);
  deps.home = home;
  const bytes = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  const files = [
    { path: "results/image.bin", content: bytes },
    { path: ".cache/generated.bin", content: Buffer.alloc(8 * 1024 * 1024, 255) },
    {
      path: ".browser-profiles/chromium/Default/data",
      content: Buffer.alloc(8 * 1024 * 1024, 128),
    },
  ];
  const longPath = `results/${"long-".repeat(24)}résumé.txt`;
  files.push({ path: longPath, content: Buffer.from("Portable filename") });
  for (const file of files) {
    const target = path.join(home.pathFor("shared"), file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  const bot = {
    name: "Helper",
    title: "",
    description: "",
    instructions: "",
    computer: { homeKey: "shared" },
  };
  const repoMock = vi.mocked(createRepos).mockReturnValue({ getBot: async () => bot } as never);
  prisma.spaceMember.findMany.mockResolvedValue([{ space: { id: "first", name: "First" } }]);
  prisma.bot.findMany.mockResolvedValue([{ id: "bot-1" }, { id: "bot-2" }] as never);
  const streamHome = vi.spyOn(home, "streamHome");
  try {
    const beforeStart = performance.now();
    const legacy = { bots: [] as { files: { path: string; content: string }[] }[] };
    for (const _bot of [1, 2]) {
      const exported = [];
      for await (const file of home.exportHome("shared", {
        operationId: "fixture",
        traceId: "fixture",
        spaceId: actor.spaceId,
        userId: actor.userId,
        signal: new AbortController().signal,
      }))
        exported.push({ path: file.path, content: new TextDecoder().decode(file.content) });
      legacy.bots.push({ files: exported });
    }
    const legacyBytes = Buffer.byteLength(JSON.stringify(legacy, null, 2));
    const beforeElapsed = performance.now() - beforeStart;
    const corrupted = legacy.bots[0]!.files.find((file) => file.path === "results/image.bin")!;
    expect(createHash("sha256").update(corrupted.content).digest("hex")).not.toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    legacy.bots.length = 0;
    const start = performance.now();
    const chunks: Buffer[] = [];
    for await (const chunk of await exportArchive(deps, actor)) chunks.push(chunk);
    const archive = Buffer.concat(chunks);
    const elapsed = performance.now() - start;
    if (process.env.QA_EXPORT_REPORT)
      await writeFile(
        process.env.QA_EXPORT_REPORT,
        JSON.stringify({
          fixtureExport: {
            before: { milliseconds: beforeElapsed, bytes: legacyBytes },
            after: { milliseconds: elapsed, bytes: archive.length },
          },
        }),
      );
    expect(elapsed).toBeLessThan(3000);
    expect(archive.length).toBeLessThan(64 * 1024);
    expect(streamHome).toHaveBeenCalledOnce();
    const archivePath = path.join(root, "account.tar.gz");
    const output = path.join(root, "extracted");
    await writeFile(archivePath, archive);
    await mkdir(output);
    execFileSync("tar", ["-xzf", archivePath, "-C", output]);
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    expect(manifest.spaces[0].bots.map((entry: { home: string }) => entry.home)).toEqual([
      "homes/1",
      "homes/1",
    ]);
    expect(manifest.omitted).toEqual(
      expect.arrayContaining([
        { path: "homes/1/.cache", reason: "Regenerable cache or dependencies" },
        { path: "homes/1/.browser-profiles", reason: "Browser profile data" },
      ]),
    );
    const digest = (data: Buffer) => createHash("sha256").update(data).digest("hex");
    expect(digest(await readFile(path.join(output, "homes/1/results/image.bin")))).toBe(
      digest(bytes),
    );
    expect(await readFile(path.join(output, "homes/1", longPath), "utf8")).toBe(
      "Portable filename",
    );
    expect(await readFile(path.join(output, "uploads/1"), "utf8")).toBe("hello");
    expect(execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })).not.toMatch(
      /generated.bin|Default\/data/,
    );

    const single: Buffer[] = [];
    for await (const chunk of await exportArchive(deps, actor, "bot-1")) single.push(chunk);
    await writeFile(archivePath, Buffer.concat(single));
    execFileSync("tar", ["-xzf", archivePath, "-C", output]);
    expect(JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8")).home).toBe(
      "homes/1",
    );
    expect(digest(await readFile(path.join(output, "homes/1/results/image.bin")))).toBe(
      digest(bytes),
    );
  } finally {
    repoMock.mockReset();
    repoMock.mockImplementation(
      () =>
        ({
          getBot: async () => ({
            name: "Helper",
            title: "",
            description: "",
            instructions: "",
            computer: null,
          }),
        }) as never,
    );
    await rm(root, { recursive: true, force: true });
  }
});
it("fails the download instead of producing a complete archive when an upload is unreadable", async () => {
  const { deps } = fixture();
  vi.mocked(deps.artifacts.get).mockRejectedValue(new Error("unreadable"));
  const stream = await exportArchive(deps, actor);
  await expect(async () => {
    for await (const _chunk of stream) {
      /* drain */
    }
  }).rejects.toThrow("unreadable");
});
it("requires authentication and serves a streamed attachment with no cache", async () => {
  const { deps } = fixture();
  const app = new Hono();
  const authenticate = vi.fn(async () => null as Actor | null);
  mountExportRoutes(app, deps, authenticate);
  expect((await app.request("/api/exports/account")).status).toBe(401);
  authenticate.mockResolvedValue(actor);
  const response = await app.request("/api/exports/account");
  expect(response.headers.get("content-disposition")).toBe(
    'attachment; filename="account-v2.tar.gz"',
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
});
afterEach(() => vi.restoreAllMocks());
