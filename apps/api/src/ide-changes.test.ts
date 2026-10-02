import type { Actor, IdeRoot } from "@ardurbot/contracts";
import type { PrismaClient } from "@ardurbot/db";
import { describe, expect, it, vi } from "vitest";
import { createIdeChanges } from "./ide-changes.js";
import type { createIdeFiles } from "./ide-files.js";

const actor = { userId: "owner", spaceId: "space" } as Actor;
const input = { rootId: "root", since: "2026-01-02T00:00:00Z", until: "2026-01-03T00:00:00Z" };
const event = (id: string, file: string, computerId = "computer") => ({
  id,
  botId: "bot",
  runId: "run",
  createdAt: new Date("2026-01-02T12:00:00Z"),
  type: "computer.file.changed",
  payload: { path: file, computerId, source: "tool", before: "old", after: "new" },
});
function fixture(kind: "host" | "sandbox" = "sandbox") {
  const root: IdeRoot = {
    id: "root",
    kind,
    path: kind === "host" ? "/workspace/project" : "/",
    computerId: kind === "host" ? null : "computer",
    botId: "bot",
    name: "Project",
  };
  const findMany = vi.fn<
    () => Promise<
      Array<{
        id: string;
        botId: string;
        runId: string;
        createdAt: Date;
        type: string;
        payload: unknown;
      }>
    >
  >(async () => [
    event("first", "src/main.ts"),
    event("foreign", "secret", "other"),
    event("escape", "../outside"),
  ]);
  const resolveCommandCwd = vi.fn(async () => "/home/ardurbot");
  const resolve = vi.fn(async () => ({
    root,
    computer: { id: "computer", kind: "fake", homeKey: "home", providerRef: "ref" },
    context: { botId: "bot" },
  }));
  const checkedRoot = vi.fn(async () => ({
    root,
    computer: { id: "computer", kind: "fake", scope: "team", homeKey: "home", providerRef: "ref" },
    context: { botId: "bot" },
  }));
  const changes = createIdeChanges(
    {
      prisma: { event: { findMany } } as unknown as PrismaClient,
      sandbox: { resolveCommandCwd },
    } as unknown as Parameters<typeof createIdeChanges>[0],
    {
      resolve,
      checkedRoot,
    } as unknown as ReturnType<typeof createIdeFiles>,
  );
  return { changes, findMany, resolve, checkedRoot, resolveCommandCwd };
}
describe("IDE change history", () => {
  const target = { rootId: "root", botId: "bot", computerId: "computer", generation: 1 };
  it("checks the selected bot root, strips its Team prefix, and excludes other bots", async () => {
    const f = fixture();
    f.findMany.mockResolvedValue([
      event("selected", "bots/bot/src/main.ts"),
      { ...event("other", "bots/bot/secret"), botId: "other" },
      event("outside", "bots/other/secret"),
    ]);
    expect(await f.changes(actor, { ...input, target, changeId: "selected" })).toMatchObject({
      items: [{ id: "selected", path: "src/main.ts", botId: "bot" }],
    });
    expect(f.checkedRoot).toHaveBeenCalledWith(actor, target);
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: "bot",
          thread: { userId: "owner", spaceId: "space" },
        }),
      }),
    );
    await expect(f.changes(actor, { ...input, target, changeId: "other" })).rejects.toThrow(
      "Resource not found",
    );
    await expect(f.changes(actor, { ...input, target, changeId: "missing" })).rejects.toThrow(
      "Resource not found",
    );
  });
  it.each(["Resource not found", "Computer changed. Refresh files."])(
    "refuses an unauthorized or stale bound change before querying events: %s",
    async (message) => {
      const f = fixture();
      f.checkedRoot.mockRejectedValue(new Error(message));
      await expect(f.changes(actor, { ...input, target, changeId: "selected" })).rejects.toThrow(
        message,
      );
      expect(f.findMany).not.toHaveBeenCalled();
    },
  );
  it("refuses a mismatched root and unbound change target", async () => {
    const f = fixture();
    await expect(
      f.changes(actor, { ...input, target: { ...target, rootId: "foreign" } }),
    ).rejects.toThrow("Resource not found");
    await expect(f.changes(actor, { ...input, changeId: "selected" })).rejects.toThrow(
      "Resource not found",
    );
    expect(f.findMany).not.toHaveBeenCalled();
  });
  it("pages through a checked target older than the first bounded event page", async () => {
    const f = fixture();
    f.findMany.mockResolvedValueOnce(
      Array.from({ length: 201 }, (_, index) => event(`new-${index}`, "bots/bot/other.ts")),
    );
    expect(await f.changes(actor, { ...input, target, changeId: "selected" })).toEqual({
      items: [],
      nextCursor: "new-199",
    });
    f.findMany.mockResolvedValueOnce([event("selected", "bots/bot/main.ts")]);
    expect(
      await f.changes(actor, { ...input, target, changeId: "selected", cursor: "new-199" }),
    ).toMatchObject({ items: [{ id: "selected", path: "main.ts" }], nextCursor: null });
  });
  const command = (id: string, cwd: string) => ({
    ...event(id, "main.ts"),
    type: "command.finished",
    payload: {
      block: {
        commandId: id,
        runId: "run",
        attemptId: null,
        executionId: id,
        command: "git diff",
        cwd,
        computerId: "computer",
        computer: "Test",
        startedAt: input.since,
        durationMs: 1,
        exitCode: 0,
        outcome: "completed",
        stdout: "--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+new\n",
        stderr: "",
        error: null,
        redacted: false,
        truncated: false,
        replayOf: null,
        rerunDisabledReason: null,
      },
    },
  });
  it.each(["ardurbot-home", "/dynamic/workspaces/session/home", "/home/ardurbot"])(
    "maps command paths through the provider home %s",
    async (home) => {
      const f = fixture();
      f.resolveCommandCwd.mockResolvedValue(home);
      f.findMany.mockResolvedValue([
        command("command", `${home}/project`),
        command("outside", `${home}-neighbor`),
      ]);
      expect((await f.changes(actor, input)).items).toMatchObject([
        { id: "command-0", path: "project/main.ts" },
      ]);
      expect((await f.changes(actor, input)).items).toHaveLength(1);
      expect(f.resolveCommandCwd).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "fake" }),
        undefined,
        expect.objectContaining({ botId: "bot" }),
        { activate: false },
      );
    },
  );
  it("scopes today's history to membership, own conversations, selected computer and root", async () => {
    const f = fixture();
    expect((await f.changes(actor, input)).items.map((item) => item.id)).toEqual(["first"]);
    expect(f.resolve).toHaveBeenCalledWith(actor, "root");
    expect(f.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          spaceId: "space",
          thread: { userId: "owner", spaceId: "space" },
          createdAt: { gte: new Date(input.since), lt: new Date(input.until) },
        }),
      }),
    );
    await expect(f.changes(actor, { ...input, until: "2026-01-04T00:00:00Z" })).rejects.toThrow();
  });
  it("returns stored file snapshots when the provider cannot resolve its home", async () => {
    const f = fixture();
    f.findMany.mockResolvedValue([
      event("stored", "saved.txt"),
      command("command", "/home/ardurbot"),
    ]);
    f.resolveCommandCwd.mockRejectedValue(new Error("Computer is unavailable"));
    await expect(f.changes(actor, input)).resolves.toMatchObject({
      items: [{ id: "stored", path: "saved.txt" }],
    });
  });
  it("maps host absolute paths and excludes neighbors and relative paths with unknown roots", async () => {
    const f = fixture("host");
    f.findMany.mockResolvedValue([
      event("file", "/workspace/project/src/main.ts"),
      event("neighbor", "/workspace/project-other/secret"),
      event("unknown", "main.ts"),
    ]);
    expect((await f.changes(actor, input)).items).toMatchObject([
      { id: "file", path: "src/main.ts" },
    ]);
  });
  it("pages event history even if the first page contains no matching files", async () => {
    const f = fixture();
    f.findMany.mockResolvedValue(
      Array.from({ length: 201 }, (_, index) => event(`event-${index}`, "file", "other")),
    );
    expect(await f.changes(actor, input)).toEqual({ items: [], nextCursor: "event-199" });
    await f.changes(actor, { ...input, cursor: "event-199" });
    expect(f.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: "event-199" }, skip: 1 }),
    );
  });
});
