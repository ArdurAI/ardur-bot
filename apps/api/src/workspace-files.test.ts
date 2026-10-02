import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalAgentHomeStore } from "@ardurbot/adapters";
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

  it("keeps connectionless host files out of the implicit workspace", async () => {
    const f = fixture();
    f.computer.kind = "desktop";
    expect(await f.files.describe(actor, "bot")).toMatchObject({
      files: "unavailable",
      runsOnHost: true,
    });
    await expect(f.files.list(actor, f.input)).rejects.toThrow("Files are unavailable");
    await expect(f.files.read(actor, { ...f.input, path: "notes.md" })).rejects.toThrow(
      "Files are unavailable",
    );
    await expect(
      f.files.save(actor, {
        ...f.input,
        path: "notes.md",
        content: "edited",
        version: digest("hello"),
        approved: false,
      }),
    ).rejects.toThrow("Files are unavailable");
    expect(f.sandbox.listFiles).not.toHaveBeenCalled();
    expect(f.sandbox.readFile).not.toHaveBeenCalled();
    expect(f.sandbox.writeFile).not.toHaveBeenCalled();
    expect(f.home.list).not.toHaveBeenCalled();
    expect(f.home.readFile).not.toHaveBeenCalled();
    expect(f.home.writeFile).not.toHaveBeenCalled();
  });

  it("distinguishes live, saved, and unavailable computers without activating one", async () => {
    const f = fixture();
    expect(await f.files.describe(actor, "bot")).toMatchObject({ files: "live", generation: 2 });
    expect(f.sandbox.listFiles).not.toHaveBeenCalled();
    f.computer.state = "stopped";
    expect(await f.files.describe(actor, "bot")).toMatchObject({ files: "saved" });
    f.computer.kind = "desktop";
    expect(await f.files.describe(actor, "bot")).toMatchObject({ files: "unavailable" });
    f.computer.state = "running";
    expect(await f.files.describe(actor, "bot")).toMatchObject({ files: "unavailable" });
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

  it("saves through the same ownership, maintenance, approval, and version checks as the IDE", async () => {
    const f = fixture();
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
      { path: "bots/bot/notes.md", content: new TextEncoder().encode("hello!"), executable: true },
      expect.anything(),
    );
    expect(f.db.computer.updateMany).toHaveBeenCalledWith({
      where: { id: "computer" },
      data: { updatedAt: expect.any(Date) },
    });

    f.sandbox.writeFile.mockClear();
    await expect(f.files.save(actor, { ...save, version: "b".repeat(64) })).resolves.toMatchObject({
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
  });

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
