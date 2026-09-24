import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgresDocumentStore } from "@ardurbot/memory";
import {
  memoryConformance,
  memoryTestAccess,
  memoryTestCommit,
} from "@ardurbot/testkit/memory-conformance";
import { memoryDatabaseFake, serialMemoryLock } from "@ardurbot/testkit/memory-fakes";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryFilesystemFake } from "./filesystem-fake.js";
import { MarkdownFiles, parseRevisionMarkdown, revisionMarkdown } from "./markdown-files.js";
import {
  ObsidianDocumentStore,
  VaultWithPrivateDocuments,
  vaultNotePath,
} from "./obsidian-store.js";

async function createFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "memory-fixture-")));
  await Promise.all(["space-a", "space-b", "quarantine"].map((dir) => mkdir(path.join(root, dir))));
  const database = memoryDatabaseFake();
  const lock = serialMemoryLock();
  const vault = (spaceId: string) =>
    new ObsidianDocumentStore({
      files: new MarkdownFiles(path.join(root, spaceId)),
      quarantine: new MarkdownFiles(path.join(root, "quarantine")),
      spaceId,
      ownerUserId: "user-a",
      exclusive: lock,
      clock: () => new Date("2026-09-23T12:00:00.000Z"),
    });
  return {
    root,
    vault,
    store: (spaceId: string) =>
      new VaultWithPrivateDocuments(
        vault(spaceId),
        new PostgresDocumentStore(database.tx),
        "user-a",
      ),
    restart: () => undefined,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
memoryConformance("Obsidian with private companion", createFixture);
async function fakeFixture() {
  const fake = memoryFilesystemFake();
  const database = memoryDatabaseFake();
  const lock = serialMemoryLock();
  const vault = (spaceId: string) =>
    new ObsidianDocumentStore({
      files: new MarkdownFiles(`/fixture/${spaceId}`, fake.filesystem),
      quarantine: new MarkdownFiles("/fixture/quarantine", fake.filesystem),
      spaceId,
      ownerUserId: "user-a",
      exclusive: lock,
      clock: () => new Date("2026-09-23T12:00:00.000Z"),
    });
  return {
    fake,
    vault,
    store: (spaceId: string) =>
      new VaultWithPrivateDocuments(
        vault(spaceId),
        new PostgresDocumentStore(database.tx),
        "user-a",
      ),
    restart: () => undefined,
  };
}
memoryConformance("Obsidian fake filesystem", fakeFixture);
afterEach(() => vi.unstubAllGlobals());
describe("vault filesystem boundary", () => {
  it("preserves an external edit detected at the atomic write boundary", async () => {
    const f = await fakeFixture();
    const files = new MarkdownFiles("/fixture/space-a", f.fake.filesystem);
    await files.write("fact.md", "Original");
    f.fake.entries.set("/fixture/space-a/fact.md", { kind: "file", text: "Concurrent edit" });
    await expect(files.write("fact.md", "App edit", true, "Original")).rejects.toMatchObject({
      code: "MEMORY_CONFLICT",
    });
    expect(await files.read("fact.md")).toBe("Concurrent edit");
    expect([...f.fake.entries.keys()].some((name) => name.endsWith(".tmp"))).toBe(false);
  });
  it("quarantines a credential-shaped journal outside the selected folder and fails closed", async () => {
    const f = await fakeFixture();
    const shape = ["gh", "p_", "x".repeat(36)].join("");
    f.fake.entries.set("/fixture/space-a/.ardur-memory.json", { kind: "file", text: shape });
    await expect(f.vault("space-a").list({}, memoryTestAccess())).rejects.toThrow("quarantined");
    expect(
      [...f.fake.entries].some(
        ([name, file]) => name.startsWith("/fixture/quarantine/") && file.text === shape,
      ),
    ).toBe(true);
    expect(f.fake.entries.get("/fixture/space-a/.ardur-memory.json")?.text).not.toContain(shape);
    await expect(
      f.vault("space-a").commit(memoryTestCommit(memoryTestAccess()), memoryTestAccess()),
    ).rejects.toThrow();
  });
  it("pages past retained Postgres copies when only later private documents are active there", async () => {
    const f = await fakeFixture();
    const access = memoryTestAccess();
    const store = f.store(access.spaceId);
    const own = await store.commit(memoryTestCommit(access, "Private", "bot"), access);
    const retained = {
      ...own,
      scopeKey: { kind: "user" as const, spaceId: access.spaceId, userId: access.userId },
    };
    const vault = { list: vi.fn(async () => ({ items: [], nextCursor: null })) };
    const privateStore = {
      list: vi
        .fn()
        .mockResolvedValueOnce({
          items: Array.from({ length: 100 }, (_, i) => ({ ...retained, id: `a-${i}` })),
          nextCursor: "retained",
        })
        .mockResolvedValueOnce({ items: [own], nextCursor: null }),
    };
    const composite = new VaultWithPrivateDocuments(
      vault as never,
      privateStore as never,
      access.userId,
    );
    expect(await composite.list({ limit: 1 }, access)).toEqual({ items: [own], nextCursor: null });
    expect(privateStore.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "retained" }),
      access,
    );
  });
  it("does not partially commit when atomic publication fails, and repairs a crash after durable commit", async () => {
    const f = await fakeFixture();
    const access = memoryTestAccess();
    const store = f.vault(access.spaceId);
    f.fake.failNextRename(".ardur-memory.json");
    await expect(store.commit(memoryTestCommit(access), access)).rejects.toThrow();
    expect((await f.vault(access.spaceId).list({}, access)).items).toEqual([]);
    f.fake.failNextRename("MEMORY.md");
    await expect(store.commit(memoryTestCommit(access), access)).rejects.toThrow();
    // The journal committed before the process failed to publish the generated index.
    const restored = await f.vault(access.spaceId).list({}, access);
    expect(restored.items).toHaveLength(1);
    expect(f.fake.entries.get("/fixture/space-a/memories/MEMORY.md")?.text).toContain(
      restored.items[0]!.id,
    );
    expect([...f.fake.entries.keys()].some((name) => name.endsWith(".tmp"))).toBe(false);
  });
  it("keeps import previews read-only in an empty folder", async () => {
    const f = await fakeFixture();
    const before = [...f.fake.entries.keys()];
    await f.vault("space-a").exportBundle(memoryTestAccess());
    expect([...f.fake.entries.keys()]).toEqual(before);
  });
  it("reconciles an external edit, conflicts stale editors, preserves attribution and siblings", async () => {
    const f = await createFixture();
    try {
      const access = memoryTestAccess();
      const request = memoryTestCommit(access);
      const store = f.vault(access.spaceId);
      const first = await store.commit(request, access);
      const note = path.join(f.root, access.spaceId, vaultNotePath(first));
      const original = await readFile(note, "utf8");
      await writeFile(note, original.replace(first.content, "Edited in a text editor"));
      await expect(
        store.commit(
          { ...request, id: first.id, expectedRevision: 1, content: "Concurrent app edit" },
          access,
        ),
      ).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
      const reconciled = await f.vault(access.spaceId).read(first.id, access);
      expect(reconciled).toMatchObject({
        revision: 2,
        content: "Edited in a text editor",
        author: { kind: "user", userId: "user-a" },
        model: null,
      });
      await writeFile(note, original.replace(first.content, "Stale external edit"));
      await expect(store.read(first.id, access)).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
      expect((await readdir(path.dirname(note))).some((name) => name.includes(".conflict-"))).toBe(
        true,
      );
      expect((await f.vault(access.spaceId).read(first.id, access))?.content).toBe(
        "Edited in a text editor",
      );
      expect(await readdir(path.join(f.root, access.spaceId, "history", first.id))).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  });
  it("quarantines credential-shaped external edits outside the synced folder", async () => {
    const f = await createFixture();
    try {
      const access = memoryTestAccess();
      const store = f.vault(access.spaceId);
      const saved = await store.commit(memoryTestCommit(access), access);
      const file = path.join(f.root, access.spaceId, vaultNotePath(saved));
      const fakeShape = ["gh", "p_", "x".repeat(36)].join("");
      await writeFile(file, revisionMarkdown({ ...saved, content: fakeShape }));
      await expect(store.read(saved.id, access)).rejects.toThrow(/quarantined/);
      expect(await readdir(path.join(f.root, "quarantine"))).toHaveLength(1);
      expect(await readFile(file, "utf8")).not.toContain(fakeShape);
      expect(JSON.stringify(await store.exportBundle(access))).not.toContain(fakeShape);
    } finally {
      await f.dispose();
    }
  });
  it("rejects leaf, ancestor and root symlinks before reading or writing their targets", async () => {
    const f = await createFixture();
    try {
      const files = new MarkdownFiles(path.join(f.root, "space-a"));
      await symlink(path.join(f.root, "quarantine"), path.join(f.root, "space-a", "escape"));
      await expect(files.write("escape/out.md", "no")).rejects.toThrow(/symbolic/);
      await symlink(
        path.join(f.root, "quarantine", "target.md"),
        path.join(f.root, "space-a", "leaf.md"),
      );
      await expect(files.read("leaf.md")).rejects.toThrow(/symbolic/);
      await symlink(path.join(f.root, "space-a"), path.join(f.root, "linked"));
      await expect(new MarkdownFiles(path.join(f.root, "linked")).read("note.md")).rejects.toThrow(
        /symbolic/,
      );
      expect(await readdir(path.join(f.root, "quarantine"))).toEqual([]);
    } finally {
      await f.dispose();
    }
  });
  it("keeps private bot and other-user documents out of the selected folder and uses no network", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Network prohibited");
    });
    vi.stubGlobal("fetch", fetch);
    const f = await createFixture();
    try {
      const own = memoryTestAccess();
      const other = memoryTestAccess("space-a", "user-b");
      const store = f.store("space-a");
      await store.commit(memoryTestCommit(own, "private bot", "bot"), own);
      await store.commit(memoryTestCommit(other, "other user", "user"), other);
      expect((await f.vault("space-a").exportBundle(own)).documents).toEqual([]);
      expect((await store.list({}, own)).items).toHaveLength(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  });
  it("uses readable YAML frontmatter and preserves Markdown exactly", () => {
    const revision = {
      documentId: "doc",
      revision: 1,
      scopeKey: { kind: "user" as const, spaceId: "space", userId: "user" },
      path: "note.md",
      content: "# A fact\n\n- One\n",
      author: { kind: "user" as const, userId: "user" },
      model: null,
      runId: null,
      threadId: null,
      references: [],
      createdAt: "2026-09-23T12:00:00.000Z",
      deletedAt: null,
    };
    expect(parseRevisionMarkdown(revisionMarkdown(revision))).toEqual(revision);
  });
});
