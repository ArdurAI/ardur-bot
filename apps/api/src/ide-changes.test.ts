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
  const findMany = vi.fn(async () => [
    event("first", "src/main.ts"),
    event("foreign", "secret", "other"),
    event("escape", "../outside"),
  ]);
  const resolve = vi.fn(async () => ({ root }));
  const changes = createIdeChanges({ prisma: { event: { findMany } } as unknown as PrismaClient }, {
    resolve,
  } as unknown as ReturnType<typeof createIdeFiles>);
  return { changes, findMany, resolve };
}
describe("IDE change history", () => {
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
