import { createHash } from "node:crypto";
import type { Actor } from "@ardurbot/contracts";
import { IDE_FILE_BYTES } from "@ardurbot/contracts";
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
      reason: "Read only: file is larger than 2 MB",
    });
    expect(f.sandbox.listFiles).not.toHaveBeenCalled();

    f.computer.maintenanceId = "maintenance";
    await expect(f.files.read(actor, { ...f.input, path: "notes.md" })).resolves.toMatchObject({
      content: "saved",
      version: digest("saved"),
    });
    await expect(f.files.save(actor, { ...save, version: digest("saved") })).rejects.toThrow(
      /Computer is busy/,
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
      reason: "Binary file",
    });
    const oversized = new Uint8Array(IDE_FILE_BYTES + 1).fill(97);
    f.sandbox.readFile.mockResolvedValueOnce(oversized);
    await expect(f.files.save(actor, save)).resolves.toMatchObject({
      saved: false,
      reason: "Read only: file is larger than 2 MB",
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
});
