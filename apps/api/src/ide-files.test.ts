import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentHomeStore } from "@ardurbot/adapter-kit";
import { FakeSandboxProvider } from "@ardurbot/adapters";
import type { Actor, RuntimeComputerLocation } from "@ardurbot/contracts";
import { IDE_FILE_BYTES } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { sourceHostStatus } from "./host-status.js";
import { createIdeChanges } from "./ide-changes.js";
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
    homeRevision: "saved",
    scope: "team",
    scopeKey: "team:space",
    kind: "fake",
    connectionId: null as string | null,
    connectionSettings: null as RuntimeComputerLocation["connectionSettings"],
    state: "running",
    providerRef: ref.providerRef,
    maintenanceId: null,
    screenGeneration: 1,
  };
  const db = {
    bot: {
      findMany: vi.fn(async (_query: unknown) => [{ id: "bot", name: "Test", computer }]),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string; spaceId: string } }) =>
          where.id === "bot" && where.userId === "owner" && where.spaceId === "space"
            ? { id: "bot", name: "Test", computer }
            : null,
      ),
    },
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
  it("binds a Team root to the selected bot instead of the root list's representative", async () => {
    const f = await fixture();
    f.db.bot.findMany.mockResolvedValue([{ id: "teammate", name: "Team", computer: f.computer }]);
    const result = await f.files.checkedRoot(actor, {
      botId: "bot",
      rootId: f.input.rootId,
      computerId: "computer",
      generation: 1,
    });
    expect(result.root.botId).toBe("bot");
    expect(result.context.botId).toBe("bot");
  });
  it.each([
    { botId: "foreign" },
    { rootId: "sandbox-other-bot-computer" },
    { rootId: "host-folder" },
  ])("refuses cross-bot and host root targets before accessing files: %s", async (other) => {
    const f = await fixture();
    const read = vi.spyOn(f.sandbox, "readFile");
    await expect(
      f.files.checkedRoot(actor, {
        botId: "bot",
        rootId: f.input.rootId,
        computerId: "computer",
        generation: 1,
        ...other,
      }),
    ).rejects.toThrow("Resource not found");
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses another owner's target and stale computer generations", async () => {
    const f = await fixture();
    const binding = { botId: "bot", rootId: f.input.rootId, computerId: "computer", generation: 1 };
    await expect(f.files.checkedRoot({ ...actor, userId: "other" }, binding)).rejects.toThrow(
      "Resource not found",
    );
    await expect(f.files.checkedRoot(actor, { ...binding, generation: 0 })).rejects.toThrow(
      "Computer changed. Refresh files.",
    );
    await expect(
      f.files.checkedRoot(actor, { ...binding, computerId: "replaced" }),
    ).rejects.toThrow("Computer changed. Refresh files.");
  });
  it.each(["docker", "podman"] as const)(
    "keeps a legacy desktop %s connection in sandbox roots and routes its files there",
    async (engine) => {
      const f = await fixture();
      f.computer.kind = "desktop";
      f.computer.connectionId = "saved-connection";
      f.computer.connectionSettings = { engine };
      expect(await f.files.roots(actor)).toMatchObject([
        { kind: "sandbox", computerId: "computer" },
      ]);
      const current = await f.files.read(actor, f.input);
      expect(current.content).toBe("before\n");
      expect(
        await f.files.save(actor, {
          ...f.input,
          version: current.version,
          content: "after\n",
          approved: false,
        }),
      ).toMatchObject({ saved: true });
      expect((await f.files.read(actor, f.input)).content).toBe("after\n");
      expect(f.home.readFile).not.toHaveBeenCalled();
      f.computer.state = "stopped";
      f.home.list.mockResolvedValue([{ path: f.input.path, kind: "file", size: 5 }] as never);
      f.home.readFile.mockResolvedValue("saved");
      const saved = await f.files.read(actor, f.input);
      expect(saved.content).toBe("saved");
      expect(
        await f.files.save(actor, {
          ...f.input,
          version: saved.version,
          content: "after",
          approved: false,
        }),
      ).toMatchObject({ saved: true });
      expect(f.home.writeFile).toHaveBeenCalledWith(
        "home",
        f.input.path,
        "after",
        expect.anything(),
      );
    },
  );

  it.each(["running", "suspended"])(
    "routes a local host root to its own folder while %s",
    async (state) => {
      const f = await fixture();
      Object.assign(f.computer, { kind: "desktop", scope: "dedicated", state });
      const listed = await f.files.roots(actor);
      expect(listed).toMatchObject([{ id: "sandbox-computer", kind: "sandbox", botId: "bot" }]);
      const current = await f.files.read(actor, f.input);
      expect(current.content).toBe("before\n");
      expect(
        await f.files.save(actor, {
          ...f.input,
          version: current.version,
          content: "after\n",
          approved: false,
        }),
      ).toMatchObject({ saved: true });
      expect((await f.files.read(actor, f.input)).content).toBe("after\n");
      expect(f.home.readFile).not.toHaveBeenCalled();
      const checked = await f.files.checkedRoot(actor, {
        botId: "bot",
        rootId: f.input.rootId,
        computerId: "computer",
        generation: 1,
      });
      expect(checked.root).toMatchObject({ kind: "sandbox", botId: "bot" });
    },
  );

  it("checks a host Team root and excludes sibling, absolute and foreign recorded changes", async () => {
    const f = await fixture();
    f.computer.kind = "desktop";
    f.db.bot.findMany.mockResolvedValue([{ id: "teammate", name: "Team", computer: f.computer }]);
    const entry = (id: string, filePath: string, botId = "bot") => ({
      id,
      botId,
      runId: "run",
      createdAt: new Date("2026-01-02T12:00:00Z"),
      type: "computer.file.changed",
      payload: {
        path: filePath,
        computerId: "computer",
        source: "tool",
        before: "old",
        after: "new",
      },
    });
    const findMany = vi.fn(async () => [
      entry("own", "bots/bot/notes.md"),
      entry("sibling", "bots/teammate/private.md"),
      entry("foreign", "bots/bot/private.md", "other"),
      entry("absolute", "/registered/private.md"),
      entry("traversal", "bots/bot/../../private.md"),
    ]);
    const changes = createIdeChanges(
      {
        prisma: { ...f.db, event: { findMany } } as unknown as PrismaClient,
        sandbox: f.sandbox,
      },
      f.files,
    );
    const input = {
      rootId: f.input.rootId,
      since: "2026-01-02T00:00:00Z",
      until: "2026-01-03T00:00:00Z",
      target: { botId: "bot", rootId: f.input.rootId, computerId: "computer", generation: 1 },
    };
    expect(await changes(actor, input)).toMatchObject({ items: [{ id: "own", path: "notes.md" }] });
    expect((await changes(actor, input)).items).toHaveLength(1);
    f.db.bot.findMany.mockResolvedValue([{ id: "bot", name: "Test", computer: f.computer }]);
    const { target: _target, ...unbound } = input;
    expect(await changes(actor, unbound)).toMatchObject({
      items: [{ id: "own", path: "notes.md" }],
    });
    expect((await changes(actor, unbound)).items).toHaveLength(1);
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ botId: "bot" }),
      }),
    );
    for (const changeId of ["sibling", "foreign", "absolute", "traversal"])
      await expect(changes(actor, { ...input, changeId })).rejects.toThrow("Resource not found");
  });

  it("keeps the paired host unavailable without changing registered-folder authorization", async () => {
    const f = await fixture();
    Object.assign(f.computer, { kind: "desktop", providerRef: "host:home" });
    expect(await f.files.roots(actor)).toEqual([]);
    const read = vi.spyOn(f.sandbox, "readFile");
    await expect(f.files.read(actor, f.input)).rejects.toThrow("Resource not found");
    await expect(
      f.files.checkedRoot(actor, {
        botId: "bot",
        rootId: f.input.rootId,
        computerId: "computer",
        generation: 1,
      }),
    ).rejects.toThrow("Files are unavailable on this computer.");
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a provider-limited preview read-only instead of overwriting the unread tail", async () => {
    const f = await fixture();
    const write = vi.spyOn(f.sandbox, "writeFile");
    vi.spyOn(f.sandbox, "readFile").mockResolvedValue(new TextEncoder().encode("bef"));
    const current = await f.files.read(actor, f.input);
    expect(current).toMatchObject({ content: "bef", size: 7, readOnly: true });
    expect(
      await f.files.save(actor, {
        ...f.input,
        version: current.version,
        content: "after",
        approved: true,
      }),
    ).toMatchObject({ saved: false });
    expect(write).not.toHaveBeenCalled();
  });
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
      expect(roots).toMatchObject([
        { kind: "host", path: directory },
        { kind: "sandbox", id: "sandbox-computer" },
      ]);
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
      expect(await files.roots({ ...actor, isDeploymentOwner: false })).toMatchObject([
        { kind: "sandbox", id: "sandbox-computer" },
      ]);
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
