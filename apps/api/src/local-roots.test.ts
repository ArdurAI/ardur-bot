import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { AgentHomeStore, SandboxProvider } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";
import { bootstrapUserSpace, requireMembership } from "@ardurbot/db";
import { afterEach, expect, it, vi } from "vitest";
import { sourceHostStatus } from "./host-status.js";
import { createIdeFiles } from "./ide-files.js";

vi.mock("@ardurbot/host-runtime/host-environment", () => ({
  getHostEnvironment: async () => ({ env: { PATH: "/fixture/bin" } }),
  inspectHostEnvironment: async () => ({ tools: [], diagnostic: "" }),
}));
vi.mock("@ardurbot/host-runtime/runtimes/claude-code-runtime", () => ({
  probeClaude: async () => ({ runtimeKind: "claude-code", available: false, models: [] }),
}));
vi.mock("@ardurbot/host-runtime/runtimes/codex-app-server-runtime", () => ({
  probeCodex: async () => ({ runtimeKind: "codex-app-server", available: false, models: [] }),
}));
vi.mock("@ardurbot/host-runtime/host-integrations", () => ({
  inspectHostIntegrations: async () => [],
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The rows sign-up writes on a fresh install, kept in memory. */
function freshInstall() {
  const users = [{ id: "owner-1", email: "owner@example.test" }];
  let settings: { id: string; ownerUserId: string | null } | null = null;
  const members: { userId: string; spaceId: string }[] = [];
  const created = async ({ data }: { data: unknown }) => data;
  return {
    user: { findMany: async ({ take }: { take?: number }) => users.slice(0, take) },
    organization: { create: created },
    member: { create: created },
    space: { create: created },
    spaceMember: {
      create: async ({ data }: { data: { userId: string; spaceId: string } }) => {
        members.push(data);
        return data;
      },
      findFirst: async ({ where }: { where: { userId: string; spaceId?: string } }) => {
        const row = members.find(
          (member) =>
            member.userId === where.userId && (!where.spaceId || member.spaceId === where.spaceId),
        );
        return row ? { ...row, member: { user: users[0] } } : null;
      },
    },
    deploymentSettings: {
      upsert: async ({ create }: { create: { id: string; ownerUserId: string | null } }) => {
        settings ??= { ...create };
        return settings;
      },
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => settings,
    },
    memoryDocument: { findFirst: async () => null, create: created },
    notificationPreference: { create: created },
    bot: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

it("shows the first owner no host folders until one is added, and never the home directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "local-roots-"));
  directories.push(root);
  // The desktop points local mode at its own list. A pairing made with another server
  // left its folders beside it; they are never read.
  const rootsFile = path.join(root, "local-folders.json");
  await mkdir(path.join(root, "host-service"), { recursive: true });
  await writeFile(
    path.join(root, "host-service", "host-roots.json"),
    `${JSON.stringify([path.join(root, "outside")])}\n`,
  );
  const folder = path.join(root, "projects");
  await mkdir(folder, { recursive: true });
  await mkdir(path.join(root, "outside"), { recursive: true });
  await writeFile(path.join(folder, "notes.md"), "kept");
  await writeFile(path.join(root, "outside", "private.md"), "not shared");
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.stubEnv("ARDURBOT_HOST_ROOTS_FILE", rootsFile);

  const prisma = freshInstall();
  await bootstrapUserSpace(
    prisma,
    { id: "owner-1" },
    { signupsEnabled: "true", signupAllowlist: undefined },
  );
  const actor = await requireMembership(prisma, "owner-1");
  expect(actor.isDeploymentOwner).toBe(true);
  const files = createIdeFiles({
    prisma,
    sandbox: {} as SandboxProvider,
    home: {} as AgentHomeStore,
    env: { sandboxProvider: "desktop" },
  });

  expect((await sourceHostStatus(prisma, actor.userId, "desktop"))?.roots).toEqual([]);
  expect(await files.roots(actor)).toEqual([]);

  await writeFile(rootsFile, `${JSON.stringify([folder])}\n`);
  const status = await sourceHostStatus(prisma, actor.userId, "desktop");
  expect(status?.roots).toEqual([folder]);
  expect(status?.health?.roots).toEqual([folder]);
  const listed = await files.roots(actor);
  expect(listed.map((entry) => entry.path)).toEqual([folder]);
  expect(listed.map((entry) => entry.path)).not.toContain(homedir());
  const rootId = listed[0]!.id;
  expect((await files.read(actor, { rootId, path: "notes.md" })).content).toBe("kept");
  await expect(files.read(actor, { rootId, path: "../outside/private.md" })).rejects.toThrow();

  await writeFile(rootsFile, "[]\n");
  expect((await sourceHostStatus(prisma, actor.userId, "desktop"))?.roots).toEqual([]);
  expect(await files.roots(actor)).toEqual([]);
});

it("lists the home folder, as before, when a source checkout sets no folder list", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "source-home-"));
  directories.push(home);
  // os.homedir() reads HOME, or USERPROFILE on Windows.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  vi.stubEnv("ARDURBOT_HOST_ROOTS_FILE", undefined);
  await writeFile(path.join(home, "notes.md"), "kept");
  const prisma = freshInstall();
  await bootstrapUserSpace(
    prisma,
    { id: "owner-1" },
    { signupsEnabled: "true", signupAllowlist: undefined },
  );
  const actor = await requireMembership(prisma, "owner-1");
  const files = createIdeFiles({
    prisma,
    sandbox: {} as SandboxProvider,
    home: {} as AgentHomeStore,
    env: { sandboxProvider: "desktop" },
  });
  const status = await sourceHostStatus(prisma, actor.userId, "desktop");
  expect(status?.roots).toEqual([homedir()]);
  expect(status?.health?.roots).toEqual([homedir()]);
  const listed = await files.roots(actor);
  expect(listed.map((entry) => entry.path)).toEqual([home]);
  expect((await files.read(actor, { rootId: listed[0]!.id, path: "notes.md" })).content).toBe(
    "kept",
  );
});
