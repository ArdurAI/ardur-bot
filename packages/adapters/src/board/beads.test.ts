import { readFile } from "node:fs/promises";
import { BoardPatchSchema } from "@ardurbot/contracts/board";
import { afterEach, describe, expect, it } from "vitest";
import { BeadsBoardProvider, parseBeadsItem } from "./beads.js";
import { boardFixture } from "./test-fixture.js";
import { boardToolSchemas } from "./tools.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});
async function fixture() {
  const f = await boardFixture();
  cleanups.push(f.clean);
  return f;
}
describe("Beads provider using a recorded executable", () => {
  it("rejects assignee-filtered claiming before invoking Beads and excludes it from the tool contract", async () => {
    const f = await fixture();
    const filter = { label: "backend", assignee: "bot:builder" };
    await expect(f.provider.claim(filter, "bot:builder")).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "unrecognized_keys", keys: ["assignee"] })],
    });
    expect(f.requests).toHaveLength(0);
    expect(boardToolSchemas.board_claim.safeParse({ filter }).success).toBe(false);
    expect(boardToolSchemas.board_ready.safeParse({ filter }).success).toBe(true);
  });
  it("parses ready, blocked, list, search and both dependency shapes", async () => {
    const f = await fixture();
    expect((await f.provider.ready())[0]).toMatchObject({
      id: "board-a",
      status: "open",
      priority: 1,
    });
    expect((await f.provider.blocked())[0]?.id).toBe("board-b");
    expect(await f.provider.list({ type: "task", label: "backend" })).toHaveLength(2);
    expect(await f.provider.search("schema")).toHaveLength(2);
    const detail = await f.provider.show("board-a");
    expect(detail).toMatchObject({
      acceptanceCriteria: "Contract tests pass",
      closeWhenDone: true,
      commentCount: 1,
    });
    expect(detail.dependencies).toContainEqual({
      id: "board-b",
      type: "blocks",
      direction: "incoming",
    });
    expect(detail.comments[0]).toMatchObject({ author: "board-owner", text: "Contract checked" });
    expect(
      parseBeadsItem({
        id: "board-b",
        title: "Child",
        dependencies: [{ issue_id: "board-b", depends_on_id: "board-a", type: "parent-child" }],
      }),
    ).toMatchObject({
      parent: "board-a",
      dependencies: [{ id: "board-a", type: "parent-child", direction: "outgoing" }],
    });
  });
  it("creates, updates, claims, closes, comments and links without interpreting text", async () => {
    const f = await fixture();
    const title = "literal ; $(touch nope) `echo nope` && --file=nope";
    await f.provider.create({
      title,
      type: "feature",
      priority: 0,
      dependencies: [{ id: "board-b", type: "blocks" }],
    });
    await f.provider.update("board-a", { description: title });
    await f.provider.claim("board-a", "bot:builder");
    await f.provider.claim({ label: "backend" }, "bot:builder");
    expect((await f.provider.close(["board-a"], title))[0]?.status).toBe("closed");
    expect((await f.provider.comment("board-a", "--file sensitive")).text).toBe("Contract checked");
    await f.provider.link("board-b", "board-a", "blocks");
    expect(f.requests.find((r) => r.argv[0] === "create")?.argv).toContain(title);
    expect(f.requests.find((r) => r.argv[0] === "update")?.argv).toEqual([
      "update",
      "board-a",
      "--description",
      title,
    ]);
    expect(f.requests.find((r) => r.argv[0] === "dep")?.argv).toEqual([
      "dep",
      "add",
      "board-a",
      "board-b",
      "--type",
      "blocks",
    ]);
    expect(f.requests.find((r) => r.argv.includes("--claim"))?.actor).toBe("bot:builder");
    expect(f.requests.find((r) => r.argv[0] === "comments")?.argv).toEqual([
      "comments",
      "add",
      "--",
      "board-a",
      "--file sensitive",
    ]);
  });
  it("reads the uppercase graph envelope and writes JSONL only under app home", async () => {
    const f = await fixture();
    const graph = await f.provider.graph();
    expect(graph.items).toHaveLength(2);
    expect(graph.edges).toEqual([{ from: "board-b", to: "board-a", type: "blocks" }]);
    const exported = await f.provider.export();
    expect(exported.path.startsWith(`${f.root}/board-exports/space/`)).toBe(true);
    expect(
      (await readFile(exported.path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toHaveLength(2);
    expect(await f.provider.listWorkspaces()).toHaveLength(2);
  });
  it("patches do not reset creation defaults", () => {
    expect(BoardPatchSchema.parse({ description: "Updated" })).toEqual({ description: "Updated" });
  });
  it("reads committed history and rejects malformed command output", async () => {
    const f = await fixture();
    const provider = new BeadsBoardProvider({
      workspace: f.workspace,
      actor: "Owner",
      run: async (request) => ({
        ok: true,
        stdout: JSON.stringify(
          request.argv[0] === "history"
            ? [
                {
                  CommitHash: "abc123",
                  Committer: "Owner",
                  CommitDate: "2026-01-01T00:00:00Z",
                  Issue: { status: "open", title: "Example" },
                },
              ]
            : [{ id: "board-a", title: "Example" }],
        ),
      }),
    });
    expect((await provider.show("board-a")).history).toEqual([
      {
        id: "abc123",
        author: "Owner",
        createdAt: "2026-01-01T00:00:00Z",
        message: "open · Example",
      },
    ]);
    const invalid = new BeadsBoardProvider({
      workspace: f.workspace,
      actor: "Owner",
      run: async () => ({ ok: true, stdout: "invalid JSON" }),
    });
    await expect(invalid.ready()).rejects.toMatchObject({ problem: { code: "invalid_response" } });
  });
});
