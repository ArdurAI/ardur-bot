import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopSandboxProvider, LocalAgentHomeStore } from "@ardurbot/adapters";
import type { Actor, RuntimeComputerLocation } from "@ardurbot/contracts";
import { IDE_FILE_BYTES } from "@ardurbot/contracts";
import { IsolationError } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceFiles, workspaceFileSource } from "./workspace-files.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

const actor: Actor = {
  userId: "owner",
  spaceId: "space",
  email: "owner@example.test",
  isDeploymentOwner: true,
};
function fixture() {
  const computer = {
    id: "computer",
    screenGeneration: 2,
    kind: "docker",
    connectionId: null as string | null,
    connectionSettings: null as RuntimeComputerLocation["connectionSettings"],
    scope: "team",
    homeKey: "home",
    homeRevision: "saved",
    state: "running",
    providerRef: "provider-ref",
    maintenanceId: null,
  };
  const db = {
    bot: {
      findFirst: vi.fn(
        async ({ where }: { where: { userId: string; spaceId: string; id: string } }) =>
          where.userId === actor.userId && where.spaceId === actor.spaceId && where.id === "bot"
            ? { id: "bot", computer }
            : null,
      ),
      findMany: vi.fn(async () => [{ id: "bot" }, { id: "teammate" }]),
    },
    actionApprovalRule: { findMany: vi.fn(async () => []) },
    computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const sandbox = {
    listFiles: vi.fn(async (_ref: unknown, _path: string) => [
      { path: "bots/bot/notes.md", kind: "file", size: 5 },
      { path: "bots/other/private.md", kind: "file", size: 7 },
    ]),
    readFile: vi.fn(async () => new TextEncoder().encode("hello")),
    writeFile: vi.fn(async () => undefined),
  };
  const home = {
    list: vi.fn(async () => [{ path: "bots/bot/notes.md", kind: "file", size: 5 }]),
    readFile: vi.fn(async () => "saved"),
    writeFile: vi.fn(async () => undefined),
  };
  const files = createWorkspaceFiles({ sandbox, home, prisma: db } as unknown as Parameters<
    typeof createWorkspaceFiles
  >[0]);
  const input = { botId: "bot", computerId: "computer", generation: 2, path: "" };
  return { computer, db, sandbox, home, files, input };
}

describe("bot workspace files", () => {
  it("describes the bot root and refuses a mismatched root before list, read or save", async () => {
    const f = fixture();
    expect(await f.files.describe(actor, "bot")).toMatchObject({ rootId: "sandbox-computer" });
    const input = { ...f.input, rootId: "sandbox-other", path: "notes.md" };
    await expect(f.files.list(actor, input)).rejects.toThrow("Resource not found");
    await expect(f.files.read(actor, input)).rejects.toThrow("Resource not found");
    await expect(
      f.files.save(actor, { ...input, content: "draft", version: digest("hello"), approved: true }),
    ).rejects.toThrow("Resource not found");
    expect(f.sandbox.listFiles).not.toHaveBeenCalled();
    expect(f.sandbox.readFile).not.toHaveBeenCalled();
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
  });
  it.each(["docker", "podman"] as const)(
    "uses live and saved workspace files for legacy desktop rows on %s",
    async (engine) => {
      const f = fixture();
      f.computer.kind = "desktop";
      f.computer.connectionId = "saved-connection";
      f.computer.connectionSettings = { engine };
      expect(await f.files.describe(actor, "bot")).toMatchObject({
        files: "live",
        runsOnHost: false,
      });
      expect((await f.files.list(actor, f.input)).entries).toEqual([
        { path: "notes.md", kind: "file", size: 5 },
      ]);
      const live = await f.files.read(actor, { ...f.input, path: "notes.md" });
      expect(live.content).toBe("hello");
      expect(
        await f.files.save(actor, {
          ...f.input,
          path: "notes.md",
          content: "edited",
          version: live.version,
          approved: false,
        }),
      ).toMatchObject({ saved: true });
      expect(f.sandbox.writeFile).toHaveBeenCalled();
      expect(f.home.list).not.toHaveBeenCalled();
      f.computer.state = "stopped";
      expect(await f.files.describe(actor, "bot")).toMatchObject({
        files: "saved",
        runsOnHost: false,
      });
      const saved = await f.files.read(actor, { ...f.input, path: "notes.md" });
      expect(saved.content).toBe("saved");
      expect(
        await f.files.save(actor, {
          ...f.input,
          path: "notes.md",
          content: "edited",
          version: saved.version,
          approved: false,
        }),
      ).toMatchObject({ saved: true });
      expect(f.home.writeFile).toHaveBeenCalled();
    },
  );

  it.each(["running", "suspended"])(
    "serves a connectionless host's own Team folder while %s",
    async (state) => {
      const f = fixture();
      f.computer.kind = "desktop";
      f.computer.state = state;
      expect(await f.files.describe(actor, "bot")).toMatchObject({
        files: "live",
        runsOnHost: true,
        rootId: "sandbox-computer",
      });
      expect((await f.files.list(actor, f.input)).entries).toEqual([
        { path: "notes.md", kind: "file", size: 5 },
      ]);
      const file = await f.files.read(actor, { ...f.input, path: "notes.md" });
      expect(file.content).toBe("hello");
      expect(
        await f.files.save(actor, {
          ...f.input,
          path: "notes.md",
          content: "edited",
          version: file.version,
          approved: false,
        }),
      ).toMatchObject({ saved: true });
      expect(f.sandbox.listFiles).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "desktop", providerRef: "provider-ref" }),
        "bots/bot",
        expect.objectContaining({ fileRoot: "bots/bot" }),
      );
      expect(f.home.list).not.toHaveBeenCalled();
      expect(f.home.readFile).not.toHaveBeenCalled();
      expect(f.home.writeFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    { kind: "desktop", connectionId: null, scope: "dedicated", state: "running", expected: "live" },
    { kind: "desktop", connectionId: null, scope: "team", state: "suspended", expected: "live" },
    {
      kind: "desktop",
      connectionId: "container",
      connectionSettings: { engine: "docker" },
      state: "suspended",
      expected: "saved",
    },
    { kind: "remote-docker", state: "running", expected: "live" },
    { kind: "fake", state: "running", expected: "unavailable" },
    { kind: "desktop", providerRef: "host:home", expected: "unavailable" },
    { kind: "desktop", providerRef: null, homeRevision: "empty", expected: "unavailable" },
    // A stopped paired bridge keeps a server-side checkpoint but no location to tell it apart.
    {
      kind: "desktop",
      connectionId: null,
      providerRef: null,
      homeRevision: "rev-1",
      state: "stopped",
      expected: "unavailable",
    },
    { kind: "desktop", state: "stopped", expected: "saved" },
  ])(
    "describes the saved location without activating it: %s",
    async ({ expected, ...location }) => {
      const f = fixture();
      Object.assign(f.computer, location);
      expect((await f.files.describe(actor, "bot")).files).toBe(expected);
      expect(f.sandbox.listFiles).not.toHaveBeenCalled();
    },
  );

  it("distinguishes live, saved, and unavailable computers without activating one", async () => {
    const f = fixture();
    expect(await f.files.describe(actor, "bot")).toMatchObject({ files: "live", generation: 2 });
    expect(f.sandbox.listFiles).not.toHaveBeenCalled();
    f.computer.state = "stopped";
    expect(await f.files.describe(actor, "bot")).toMatchObject({ files: "saved" });
    f.computer.kind = "desktop";
    expect(await f.files.describe(actor, "bot")).toMatchObject({ files: "saved" });
    f.computer.state = "running";
    expect(await f.files.describe(actor, "bot")).toMatchObject({ files: "live" });
    expect(workspaceFileSource(null)).toBe("unavailable");
    for (const kind of ["ssh", "remote-docker", "docker", "kubernetes", "e2b", "daytona", "box"]) {
      expect(
        workspaceFileSource({
          kind,
          state: "running",
          providerRef: "connected",
          homeRevision: "empty",
          maintenanceId: null,
        }),
      ).toBe("live");
    }
    expect(
      workspaceFileSource({
        kind: "fake",
        state: "running",
        providerRef: "simulated",
        homeRevision: "saved",
        maintenanceId: null,
      }),
    ).toBe("unavailable");
  });

  it("offers the Git changes view only where the owning provider can serve it", async () => {
    const f = fixture();
    // A routing wrapper answers per computer; the tab must follow it, not the
    // wrapper's own always-defined gitChanges.
    const router = {
      ...f.sandbox,
      canObserveGit: vi.fn(async (ref: { kind?: string }) => ref.kind === "desktop"),
      gitChanges: vi.fn(async () => ({ kind: "unavailable" })),
    };
    const routed = createWorkspaceFiles({
      sandbox: router,
      home: f.home,
      prisma: f.db,
    } as unknown as Parameters<typeof createWorkspaceFiles>[0]);
    for (const kind of ["docker", "e2b", "daytona", "box"]) {
      Object.assign(f.computer, { kind, state: "running", providerRef: "provider-ref" });
      expect((await routed.describe(actor, "bot")).git).toBe(false);
    }
    // A local This computer workspace is the one place the view is offered.
    Object.assign(f.computer, { kind: "desktop", state: "running", providerRef: "provider-ref" });
    expect((await routed.describe(actor, "bot")).git).toBe(true);

    // A plain provider without the probe answers from its own shape.
    const plain = createWorkspaceFiles({
      sandbox: f.sandbox,
      home: f.home,
      prisma: f.db,
    } as unknown as Parameters<typeof createWorkspaceFiles>[0]);
    expect((await plain.describe(actor, "bot")).git).toBe(false);
    const serving = {
      ...f.sandbox,
      gitChanges: vi.fn(async () => ({ kind: "unavailable" })),
    };
    const withGit = createWorkspaceFiles({
      sandbox: serving,
      home: f.home,
      prisma: f.db,
    } as unknown as Parameters<typeof createWorkspaceFiles>[0]);
    expect((await withGit.describe(actor, "bot")).git).toBe(true);
  });

  it("rejects another actor and a replaced computer before any file read", async () => {
    const f = fixture();
    await expect(f.files.describe({ ...actor, userId: "other" }, "bot")).rejects.toThrow();
    await expect(f.files.list(actor, { ...f.input, generation: 1 })).rejects.toThrow();
    await expect(f.files.read(actor, { ...f.input, path: "../private" })).rejects.toThrow();
    expect(f.sandbox.listFiles).not.toHaveBeenCalled();
    expect(f.sandbox.readFile).not.toHaveBeenCalled();
  });

  it("lists only the bot subtree and bounds text previews", async () => {
    const f = fixture();
    const result = await f.files.list(actor, f.input);
    expect(result.entries).toEqual([{ path: "notes.md", kind: "file", size: 5 }]);
    expect(f.sandbox.listFiles.mock.calls[0]?.[1]).toBe("bots/bot");
    expect(await f.files.read(actor, { ...f.input, path: "notes.md" })).toMatchObject({
      path: "notes.md",
      content: "hello",
      size: 5,
      binary: false,
      readOnly: false,
      version: digest("hello"),
    });
    const oversized = new Uint8Array(IDE_FILE_BYTES + 1).fill(97);
    f.sandbox.readFile.mockResolvedValueOnce(oversized);
    const large = await f.files.read(actor, { ...f.input, path: "notes.md" });
    expect(large).toMatchObject({ binary: false, readOnly: true });
    expect(large.content).toHaveLength(IDE_FILE_BYTES);
    expect(large.content.startsWith("aaa")).toBe(true);
    f.sandbox.readFile.mockResolvedValueOnce(Uint8Array.from([104, 0, 105]));
    await expect(f.files.read(actor, { ...f.input, path: "notes.md" })).resolves.toMatchObject({
      binary: true,
      readOnly: true,
      content: "",
    });
    f.sandbox.listFiles.mockResolvedValueOnce([]);
    await expect(f.files.read(actor, { ...f.input, path: "missing.md" })).rejects.toThrow();
  });

  it.each(["docker", "desktop"])(
    "saves %s through the same ownership, maintenance, approval, and version checks",
    async (kind) => {
      const f = fixture();
      f.computer.kind = kind;
      const save = {
        ...f.input,
        path: "notes.md",
        content: "hello!",
        version: digest("hello"),
        approved: false,
      };
      await expect(f.files.save({ ...actor, userId: "other" }, save)).rejects.toThrow();
      await expect(f.files.save(actor, { ...save, path: "../private" })).rejects.toThrow();
      await expect(f.files.save(actor, { ...save, generation: 1 })).rejects.toThrow();
      expect(f.sandbox.writeFile).not.toHaveBeenCalled();
      expect(f.home.writeFile).not.toHaveBeenCalled();

      const tooBig = await f.files.save(actor, {
        ...save,
        content: "a".repeat(IDE_FILE_BYTES + 1),
      });
      expect(tooBig).toMatchObject({
        saved: false,
        approvalRequired: false,
        reason: "This file is larger than 2 MB. Open a copy to edit it.",
      });
      expect(f.sandbox.listFiles).not.toHaveBeenCalled();

      f.computer.maintenanceId = "maintenance";
      await expect(f.files.read(actor, { ...f.input, path: "notes.md" })).resolves.toMatchObject({
        content: "saved",
        version: digest("saved"),
      });
      await expect(f.files.save(actor, { ...save, version: digest("saved") })).rejects.toThrow(
        /The computer is busy. Wait for it to finish./,
      );
      expect(f.home.writeFile).not.toHaveBeenCalled();
      f.computer.maintenanceId = null;

      f.db.actionApprovalRule.findMany.mockResolvedValueOnce([
        { effect: "require_approval", matchKind: "tool", matchValue: "write_file", botId: null },
      ]);
      await expect(f.files.save(actor, save)).resolves.toEqual({
        saved: false,
        approvalRequired: true,
      });
      expect(f.sandbox.writeFile).not.toHaveBeenCalled();
      f.sandbox.listFiles.mockImplementation(async () => [
        { path: "bots/bot/notes.md", kind: "file", size: 5, executable: true },
      ]);
      f.db.actionApprovalRule.findMany.mockResolvedValueOnce([
        { effect: "require_approval", matchKind: "tool", matchValue: "write_file", botId: null },
      ]);
      await expect(f.files.save(actor, { ...save, approved: true })).resolves.toMatchObject({
        saved: true,
        approvalRequired: false,
        version: digest("hello!"),
      });
      expect(f.sandbox.writeFile).toHaveBeenCalledWith(
        expect.anything(),
        {
          path: "bots/bot/notes.md",
          content: new TextEncoder().encode("hello!"),
          executable: true,
        },
        expect.anything(),
      );
      expect(f.db.computer.updateMany).toHaveBeenCalledWith({
        where: { id: "computer" },
        data: { updatedAt: expect.any(Date) },
      });

      f.sandbox.writeFile.mockClear();
      await expect(
        f.files.save(actor, { ...save, version: "b".repeat(64) }),
      ).resolves.toMatchObject({
        saved: false,
        approvalRequired: false,
        reason: "The file changed. Open it again before saving.",
      });
      f.sandbox.readFile.mockResolvedValueOnce(Uint8Array.from([0]));
      await expect(f.files.save(actor, save)).resolves.toMatchObject({
        saved: false,
        reason: "This is a binary file. You cannot edit it here.",
      });
      const oversized = new Uint8Array(IDE_FILE_BYTES + 1).fill(97);
      f.sandbox.readFile.mockResolvedValueOnce(oversized);
      await expect(f.files.save(actor, save)).resolves.toMatchObject({
        saved: false,
        reason: "This file is larger than 2 MB. Open a copy to edit it.",
      });
      expect(f.sandbox.writeFile).not.toHaveBeenCalled();

      f.computer.state = "stopped";
      f.db.computer.updateMany.mockClear();
      await expect(
        f.files.save(actor, { ...save, content: "saved!", version: digest("saved") }),
      ).resolves.toMatchObject({ saved: true, version: digest("saved!") });
      expect(f.home.writeFile).toHaveBeenCalledWith(
        "home",
        "bots/bot/notes.md",
        "saved!",
        expect.anything(),
      );
      expect(f.sandbox.writeFile).not.toHaveBeenCalled();
      expect(f.db.computer.updateMany).not.toHaveBeenCalled();
    },
  );

  it("does not follow a symlink out of the bot folder when saving a stopped computer", async () => {
    const f = fixture();
    f.computer.state = "stopped";
    const root = await mkdtemp(path.join(tmpdir(), "workspace-files-"));
    const home = new LocalAgentHomeStore(root);
    const dir = home.pathFor("home");
    const secret = path.join(dir, "bots", "other", "secret.md");
    const outside = path.join(root, "outside.md");
    try {
      await mkdir(path.join(dir, "bots", "bot"), { recursive: true });
      await mkdir(path.dirname(secret), { recursive: true });
      await writeFile(secret, "secret");
      await writeFile(outside, "outside");
      await writeFile(path.join(dir, "bots", "bot", "plain.md"), "hello");
      await symlink(
        path.join("..", "other", "secret.md"),
        path.join(dir, "bots", "bot", "notes.md"),
      );
      await symlink(outside, path.join(dir, "bots", "bot", "escape.md"));
      await symlink(path.join(dir, "bots", "other"), path.join(dir, "bots", "bot", "linked"));
      const files = createWorkspaceFiles({
        sandbox: f.sandbox,
        home,
        prisma: f.db,
      } as unknown as Parameters<typeof createWorkspaceFiles>[0]);
      const outcome = async (filePath: string, version: string) =>
        files
          .save(actor, {
            ...f.input,
            path: filePath,
            content: "pwned",
            version,
            approved: false,
          })
          .then(
            (result) => result.saved,
            () => false,
          );
      expect(await outcome("notes.md", digest("secret"))).toBe(false);
      expect(await outcome("linked/secret.md", digest("secret"))).toBe(false);
      expect(await outcome("escape.md", digest("outside"))).toBe(false);
      expect(await readFile(secret, "utf8")).toBe("secret");
      expect(await readFile(outside, "utf8")).toBe("outside");
      await expect(files.read(actor, { ...f.input, path: "notes.md" })).rejects.toThrow();
      const listed = await files.list(actor, f.input);
      expect(listed.entries.map((entry) => entry.path)).toEqual(["plain.md"]);
      await expect(
        files.save(actor, {
          ...f.input,
          path: "plain.md",
          content: "hello!",
          version: digest("hello"),
          approved: false,
        }),
      ).resolves.toMatchObject({ saved: true, version: digest("hello!") });
      expect(await readFile(path.join(dir, "bots", "bot", "plain.md"), "utf8")).toBe("hello!");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["dedicated", "team"])(
    "contains a real local host's %s folder for list, read and save",
    async (scope) => {
      const f = fixture();
      const directory = await realpath(await mkdtemp(path.join(tmpdir(), "host-workspace-")));
      try {
        const sandbox = new DesktopSandboxProvider({ root: directory, restricted: true });
        const ref = await sandbox.provision(
          { botId: "home", homePath: "" },
          {
            ...actor,
            operationId: "fixture",
            traceId: "fixture",
            signal: new AbortController().signal,
          },
        );
        Object.assign(f.computer, { kind: "desktop", scope, providerRef: ref.providerRef });
        const own = scope === "team" ? path.join(ref.providerRef, "bots", "bot") : ref.providerRef;
        const outside = path.join(directory, "outside");
        await mkdir(own, { recursive: true });
        await mkdir(outside);
        await writeFile(path.join(own, "notes.md"), "hello");
        await writeFile(path.join(outside, "private.md"), "outside");
        const files = createWorkspaceFiles({
          sandbox,
          home: f.home,
          prisma: f.db,
        } as unknown as Parameters<typeof createWorkspaceFiles>[0]);
        expect((await files.list(actor, f.input)).entries.map((entry) => entry.path)).toEqual([
          "notes.md",
        ]);
        expect((await files.read(actor, { ...f.input, path: "notes.md" })).content).toBe("hello");
        const save = {
          ...f.input,
          path: "notes.md",
          content: "draft",
          version: digest("stale"),
          approved: false,
        };
        expect(await files.save(actor, save)).toMatchObject({
          saved: false,
          reason: "The file changed. Open it again before saving.",
        });
        expect(save.content).toBe("draft");
        expect(await readFile(path.join(own, "notes.md"), "utf8")).toBe("hello");
        await expect(
          files.save(actor, { ...save, version: digest("hello") }),
        ).resolves.toMatchObject({ saved: true });
        for (const escapedPath of [
          "..",
          "../outside/private.md",
          path.join(outside, "private.md"),
          "C:/outside/private.md",
          "\\\\outside\\\\private.md",
        ]) {
          await expect(files.list(actor, { ...f.input, path: escapedPath })).rejects.toThrow(
            "Path escapes registered folders.",
          );
          await expect(files.read(actor, { ...f.input, path: escapedPath })).rejects.toThrow(
            "Path escapes registered folders.",
          );
          await expect(files.save(actor, { ...save, path: escapedPath })).rejects.toThrow(
            "Path escapes registered folders.",
          );
        }
        await symlink(outside, path.join(own, "escape"));
        await expect(files.list(actor, { ...f.input, path: "escape" })).rejects.toThrow(
          "Use a path inside this bot's folder or a registered folder.",
        );
        await expect(files.read(actor, { ...f.input, path: "escape/private.md" })).rejects.toThrow(
          "Use a path inside this bot's folder or a registered folder.",
        );
        await expect(files.save(actor, { ...save, path: "escape/private.md" })).rejects.toThrow(
          "Use a path inside this bot's folder or a registered folder.",
        );
        if (scope === "team") {
          const sibling = path.join(ref.providerRef, "bots", "other");
          await mkdir(sibling);
          await writeFile(path.join(sibling, "private.md"), "sibling");
          await symlink(sibling, path.join(own, "sibling"));
          await expect(files.list(actor, { ...f.input, path: "sibling" })).rejects.toThrow(
            "Use a path inside this bot's folder or a registered folder.",
          );
          await expect(
            files.read(actor, { ...f.input, path: "sibling/private.md" }),
          ).rejects.toThrow("Use a path inside this bot's folder or a registered folder.");
          await expect(files.save(actor, { ...save, path: "sibling/private.md" })).rejects.toThrow(
            "Use a path inside this bot's folder or a registered folder.",
          );
          expect(await readFile(path.join(sibling, "private.md"), "utf8")).toBe("sibling");
        }
        expect(await readFile(path.join(outside, "private.md"), "utf8")).toBe("outside");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("describes a deleted file as a refusal with a reason, not a server error", async () => {
    const f = fixture();
    // The file was deleted in the sandbox while its tab was open.
    f.sandbox.listFiles.mockResolvedValue([]);
    await expect(
      f.files.save(actor, {
        ...f.input,
        path: "notes.md",
        content: "hello!",
        version: digest("hello"),
        approved: false,
      }),
    ).resolves.toEqual({
      saved: false,
      approvalRequired: false,
      reason: "This file no longer exists. Save it as a new file or close it.",
    });
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("describes a file deleted between the listing and the read as the same refusal", async () => {
    const f = fixture();
    // The folder listing still saw the file, then it vanished before the read.
    f.sandbox.readFile.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT: no such file or directory, open 'bots/bot/notes.md'"), {
        code: "ENOENT",
      }),
    );
    await expect(
      f.files.save(actor, {
        ...f.input,
        path: "notes.md",
        content: "hello!",
        version: digest("hello"),
        approved: false,
      }),
    ).resolves.toEqual({
      saved: false,
      approvalRequired: false,
      reason: "This file no longer exists. Save it as a new file or close it.",
    });
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("refuses when a saved file or its folder vanishes between the listing and the read", async () => {
    const f = fixture();
    f.computer.state = "stopped";
    const root = await mkdtemp(path.join(tmpdir(), "workspace-files-vanish-"));
    try {
      let vanish: (target: string) => Promise<void> = async () => undefined;
      class VanishingHomeStore extends LocalAgentHomeStore {
        override async readFile(...args: Parameters<LocalAgentHomeStore["readFile"]>) {
          await vanish(path.join(this.pathFor(args[0]), ...args[1].split("/")));
          return super.readFile(...args);
        }
      }
      const home = new VanishingHomeStore(root);
      const notes = path.join(home.pathFor("home"), "bots", "bot", "notes.md");
      await mkdir(path.dirname(notes), { recursive: true });
      await writeFile(notes, "hello");
      const files = createWorkspaceFiles({
        sandbox: f.sandbox,
        home,
        prisma: f.db,
      } as unknown as Parameters<typeof createWorkspaceFiles>[0]);
      const attempt = () =>
        files.save(actor, {
          ...f.input,
          path: "notes.md",
          content: "hello!",
          version: digest("hello"),
          approved: false,
        });
      const refusal = {
        saved: false,
        approvalRequired: false,
        reason: "This file no longer exists. Save it as a new file or close it.",
      };

      vanish = async (target) => rm(target);
      await expect(attempt()).resolves.toEqual(refusal);
      await expect(readFile(notes, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(notes, "hello");
      vanish = async (target) => rm(path.dirname(target), { recursive: true });
      await expect(attempt()).resolves.toEqual(refusal);
      await expect(readFile(notes, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a write when a commit swaps in a symlink between the check and the write", async () => {
    const f = fixture();
    f.computer.state = "stopped";
    const root = await mkdtemp(path.join(tmpdir(), "workspace-files-race-"));
    try {
      // Swaps run after the pane's read but inside the write call, which is
      // where a concurrent stop/commit would land its renamed home directory.
      let swap: () => Promise<void> = async () => undefined;
      class RacyHomeStore extends LocalAgentHomeStore {
        override async writeFile(...args: Parameters<LocalAgentHomeStore["writeFile"]>) {
          await swap();
          return super.writeFile(...args);
        }
        override async writeFileInsideRoot(
          ...args: Parameters<LocalAgentHomeStore["writeFileInsideRoot"]>
        ) {
          await swap();
          return super.writeFileInsideRoot(...args);
        }
      }
      const home = new RacyHomeStore(root);
      const dir = home.pathFor("home");
      const workspace = path.join(dir, "bots", "bot");
      const other = path.join(dir, "bots", "other", "notes.md");
      await mkdir(path.join(workspace, "sub"), { recursive: true });
      await mkdir(path.dirname(other), { recursive: true });
      await writeFile(path.join(workspace, "sub", "notes.md"), "hello");
      await writeFile(other, "secret");
      const files = createWorkspaceFiles({
        sandbox: f.sandbox,
        home,
        prisma: f.db,
      } as unknown as Parameters<typeof createWorkspaceFiles>[0]);
      const attempt = () =>
        files.save(actor, {
          ...f.input,
          path: "sub/notes.md",
          content: "pwned",
          version: digest("hello"),
          approved: false,
        });

      // A parent directory becomes a symlink into another bot's folder.
      swap = async () => {
        await rm(path.join(workspace, "sub"), { recursive: true });
        await symlink(path.join("..", "other"), path.join(workspace, "sub"));
      };
      await expect(attempt()).rejects.toThrow(IsolationError);
      expect(await readFile(other, "utf8")).toBe("secret");
      await rm(path.join(workspace, "sub"));
      await mkdir(path.join(workspace, "sub"));
      await writeFile(path.join(workspace, "sub", "notes.md"), "hello");

      // The target file itself becomes a symlink into another bot's folder.
      swap = async () => {
        await rm(path.join(workspace, "sub", "notes.md"));
        await symlink(
          path.join("..", "..", "other", "notes.md"),
          path.join(workspace, "sub", "notes.md"),
        );
      };
      await expect(attempt()).rejects.toThrow(IsolationError);
      expect(await readFile(other, "utf8")).toBe("secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
