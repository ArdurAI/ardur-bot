import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHomeStore } from "@ardurbot/adapter-kit";
import { FakeSandboxProvider } from "@ardurbot/adapters";
import type { Actor } from "@ardurbot/contracts";
import { IDE_FILE_BYTES } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { sourceHostStatus } from "./host-status.js";
import { createIdeFiles } from "./ide-files.js";

vi.mock("./host-status.js", () => ({ sourceHostStatus: vi.fn(async () => null) }));

vi.mock("@ardurbot/db", async (original) => ({
  ...(await original<object>()),
  requireMembership: async (_: unknown, user: string, space: string) => {
    if (user !== "owner" || space !== "space") throw new Error("No membership");
  },
}));
const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
async function fixture() {
  const sandbox = new FakeSandboxProvider();
  const context = {
    ...actor,
    operationId: "test",
    traceId: "test",
    signal: new AbortController().signal,
  };
  const ref = await sandbox.provision({ botId: "home", homePath: "" }, context);
  const computer = {
    id: "computer",
    spaceId: "space",
    userId: "owner",
    homeKey: "home",
    scope: "team",
    scopeKey: "team:space",
    kind: "fake",
    state: "running",
    providerRef: ref.providerRef,
    maintenanceId: null,
  };
  const db = {
    bot: { findMany: vi.fn(async (_query: unknown) => [{ id: "bot", name: "Test", computer }]) },
    computer: { findFirst: vi.fn(async () => computer), updateMany: vi.fn(async () => ({})) },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
  };
  const home = { list: vi.fn(async () => []), readFile: vi.fn(), writeFile: vi.fn() };
  const files = createIdeFiles({
    prisma: db as unknown as PrismaClient,
    sandbox,
    home: home as unknown as AgentHomeStore,
  });
  await sandbox.writeFile(
    ref,
    { path: "src/main.ts", content: new TextEncoder().encode("before\n") },
    context,
  );
  const input = { rootId: "sandbox-computer", path: "src/main.ts" };
  return { files, sandbox, computer, db, home, ref, context, input };
}
describe("IDE file operations", () => {
  it("keeps valid siblings and counts unsupported filenames", async () => {
    const f = await fixture();
    vi.spyOn(f.sandbox, "listFiles").mockResolvedValue([
      { path: "src/main.ts", kind: "file", size: 7 },
      { path: "src/legal:name", kind: "file", size: 1 },
      { path: "src/legal\\name", kind: "file", size: 1 },
    ]);
    expect(await f.files.list(actor, { ...f.input, path: "src" })).toMatchObject({
      entries: [{ path: "src/main.ts" }],
      hiddenCount: 2,
    });
    expect((await f.files.read(actor, f.input)).content).toBe("before\n");
  });
  it("edits the source host home without a paired registration and keeps it owner-only", async () => {
    const f = await fixture();
    const directory = await mkdtemp(path.join(tmpdir(), "ide-source-"));
    try {
      await writeFile(path.join(directory, "notes.md"), "before");
      if (process.platform !== "win32") {
        await writeFile(path.join(directory, "legal:name"), "fixture");
        await writeFile(path.join(directory, "legal\\name"), "fixture");
      }
      vi.mocked(sourceHostStatus).mockResolvedValue({
        configured: false,
        connected: true,
        roots: [directory],
        health: null,
      });
      f.computer.kind = "desktop";
      const files = createIdeFiles({
        prisma: f.db as unknown as PrismaClient,
        home: f.home as unknown as AgentHomeStore,
        sandbox: f.sandbox,
        env: { sandboxProvider: "desktop" },
      } as Parameters<typeof createIdeFiles>[0]);
      const roots = await files.roots(actor);
      expect(roots).toMatchObject([{ kind: "host", path: directory }]);
      const input = { rootId: roots[0]!.id, path: "notes.md" };
      expect(await files.list(actor, { ...input, path: "" })).toMatchObject({
        entries: [{ path: "notes.md" }],
        hiddenCount: process.platform === "win32" ? 0 : 2,
      });
      const current = await files.read(actor, input);
      expect(current.content).toBe("before");
      expect(
        await files.save(actor, {
          ...input,
          content: "after",
          version: current.version,
          approved: true,
        }),
      ).toMatchObject({ saved: true });
      expect(await readFile(path.join(directory, "notes.md"), "utf8")).toBe("after");
      expect(await files.roots({ ...actor, isDeploymentOwner: false })).toEqual([]);
      await expect(files.read({ ...actor, isDeploymentOwner: false }, input)).rejects.toThrow();
    } finally {
      vi.mocked(sourceHostStatus).mockResolvedValue(null);
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("lists just one directory, reads, edits and saves through the selected provider", async () => {
    const f = await fixture();
    expect(await f.files.roots(actor)).toMatchObject([
      { id: f.input.rootId, botId: "bot", computerId: "computer" },
    ]);
    expect((await f.files.list(actor, { ...f.input, path: "" })).entries).toMatchObject([
      { path: "src", kind: "dir" },
    ]);
    expect((await f.files.list(actor, { ...f.input, path: "src" })).entries).toMatchObject([
      { path: "src/main.ts", kind: "file" },
    ]);
    const read = await f.files.read(actor, f.input);
    expect(read).toMatchObject({ content: "before\n", readOnly: false, binary: false });
    expect(
      await f.files.save(actor, {
        ...f.input,
        version: read.version,
        content: "after\n",
        approved: false,
      }),
    ).toMatchObject({ saved: true });
    expect((await f.files.read(actor, f.input)).content).toBe("after\n");
  });
  it.each([
    "../outside",
    "src/../../outside",
    "/absolute",
    "C:/outside",
    "src\\outside",
    "src/\0bad",
  ])("refuses an escaped path %s before the provider", async (path) => {
    const f = await fixture();
    const write = vi.spyOn(f.sandbox, "writeFile");
    await expect(
      f.files.save(actor, {
        ...f.input,
        path,
        version: "a".repeat(64),
        content: "bad",
        approved: true,
      }),
    ).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
  it("does not use another space, a removed root or a computer under maintenance", async () => {
    const f = await fixture();
    await expect(f.files.read({ ...actor, spaceId: "other" }, f.input)).rejects.toThrow(
      "membership",
    );
    await expect(f.files.read(actor, { ...f.input, rootId: "sandbox-other" })).rejects.toThrow();
    f.computer.maintenanceId = "maintenance" as never;
    await expect(f.files.read(actor, f.input)).rejects.toThrow("busy");
  });
  it("requires the same write rule and explicit approval, and detects changed files", async () => {
    const f = await fixture();
    const read = await f.files.read(actor, f.input);
    f.db.actionApprovalRule.findMany.mockResolvedValue([
      { effect: "require_approval", matchKind: "tool", matchValue: "write_file", botId: null },
    ] as never);
    const request = { ...f.input, version: read.version, content: "approved", approved: false };
    expect(await f.files.save(actor, request)).toEqual({ saved: false, approvalRequired: true });
    expect(await f.files.save(actor, { ...request, approved: true })).toMatchObject({
      saved: true,
    });
    expect(await f.files.save(actor, { ...request, approved: true })).toMatchObject({
      saved: false,
      reason: expect.stringContaining("changed"),
    });
  });
  it.each([
    { path: "bots/second/notes.md", archived: false },
    { path: "shared/notes.md", archived: false },
    { path: "bots/second/notes.md", archived: true },
    { path: "shared/notes.md", archived: true },
  ])(
    "honors every team bot's write policy for $path (archived=$archived)",
    async ({ path, archived }) => {
      const f = await fixture();
      f.db.bot.findMany.mockImplementation(async (input) => {
        const query = input as { where: { archivedAt?: null } };
        const bots = [{ id: "bot", name: "First", computer: f.computer }];
        // An archived bot still owns files and has a write policy on the shared computer.
        if (!archived || query.where.archivedAt !== null)
          bots.push({ id: "second", name: "Second", computer: f.computer });
        return bots;
      });
      f.db.actionApprovalRule.findMany.mockResolvedValue([
        { effect: "always_allow", matchKind: "tool", matchValue: "write_file", botId: "bot" },
        {
          effect: "require_approval",
          matchKind: "tool",
          matchValue: "write_file",
          botId: "second",
        },
      ] as never);
      await f.sandbox.writeFile(
        f.ref,
        { path, content: new TextEncoder().encode("before") },
        f.context,
      );
      const input = { ...f.input, path };
      const current = await f.files.read(actor, input);
      const write = vi.spyOn(f.sandbox, "writeFile");
      const request = { ...input, content: "after", version: current.version, approved: false };
      expect(await f.files.save(actor, request)).toEqual({ saved: false, approvalRequired: true });
      expect(write).not.toHaveBeenCalled();
      expect((await f.files.read(actor, input)).content).toBe("before");
      expect(await f.files.save(actor, { ...request, approved: true })).toMatchObject({
        saved: true,
      });
    },
  );
  it("previews large files read-only, rejects binary, and enforces bytes instead of UTF-16 length", async () => {
    const f = await fixture();
    await f.sandbox.writeFile(
      f.ref,
      { path: f.input.path, content: new Uint8Array(IDE_FILE_BYTES + 20).fill(97) },
      f.context,
    );
    const large = await f.files.read(actor, f.input);
    expect(large.readOnly).toBe(true);
    expect(large.content.length).toBe(IDE_FILE_BYTES);
    expect(
      await f.files.save(actor, {
        ...f.input,
        content: "é".repeat(IDE_FILE_BYTES),
        version: large.version,
        approved: true,
      }),
    ).toMatchObject({ saved: false });
    await f.sandbox.writeFile(
      f.ref,
      { path: f.input.path, content: new Uint8Array([0, 1, 2]) },
      f.context,
    );
    const binary = await f.files.read(actor, f.input);
    expect(binary).toMatchObject({ binary: true, content: "", readOnly: true });
    expect(
      await f.files.save(actor, {
        ...f.input,
        content: "x",
        version: binary.version,
        approved: true,
      }),
    ).toMatchObject({ saved: false, reason: "Binary file" });
  });
});

it("preserves executable metadata and detects binary data in a stopped home", async () => {
  const f = await fixture();
  vi.spyOn(f.sandbox, "listFiles").mockResolvedValue([
    { path: f.input.path, kind: "file", size: 7, executable: true },
  ]);
  const write = vi.spyOn(f.sandbox, "writeFile");
  const current = await f.files.read(actor, f.input);
  await f.files.save(actor, {
    ...f.input,
    content: "after",
    version: current.version,
    approved: true,
  });
  expect(write).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ executable: true }),
    expect.anything(),
  );
  f.computer.state = "stopped";
  f.home.list.mockResolvedValue([{ path: f.input.path, kind: "file", size: 3 }] as never);
  f.home.readFile.mockRejectedValue(new Error("Binary file"));
  expect(await f.files.read(actor, f.input)).toMatchObject({
    binary: true,
    readOnly: true,
    content: "",
  });
});
