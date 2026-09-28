import type { Actor } from "@ardurbot/contracts";
import { IDE_FILE_BYTES } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { createWorkspaceFiles, workspaceFileSource } from "./workspace-files.js";

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
    },
  };
  const sandbox = {
    listFiles: vi.fn(async (_ref: unknown, _path: string) => [
      { path: "bots/bot/notes.md", kind: "file", size: 5 },
      { path: "bots/other/private.md", kind: "file", size: 7 },
    ]),
    readFile: vi.fn(async () => new TextEncoder().encode("hello")),
  };
  const home = {
    list: vi.fn(async () => [{ path: "bots/bot/notes.md", kind: "file", size: 5 }]),
    readFile: vi.fn(async () => "saved"),
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
    });
    f.sandbox.readFile.mockResolvedValueOnce(new Uint8Array(IDE_FILE_BYTES + 1));
    await expect(f.files.read(actor, { ...f.input, path: "notes.md" })).rejects.toThrow();
  });
});
