import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LifecycleMemoryStore, MemoryService, PostgresDocumentStore } from "@ardurbot/memory";
import {
  memoryConformance,
  memoryTestAccess,
  memoryTestCommit,
} from "@ardurbot/testkit/memory-conformance";
import { memoryDatabaseFake, serialMemoryLock } from "@ardurbot/testkit/memory-fakes";
import { describe, expect, it, vi } from "vitest";
import { GitDocumentStore } from "./git-store.js";
import { GitTransport } from "./git-transport.js";
import { MarkdownFiles, parseRevisionMarkdown, revisionMarkdown } from "./markdown-files.js";
import { VaultWithPrivateDocuments } from "./obsidian-store.js";

vi.setConfig({ testTimeout: 30_000 });
const exec = promisify(execFile);
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "memory-git-fixture-")));
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], {
        cwd: root,
        env: {
          PATH: "/usr/bin:/bin:/usr/local/bin",
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      })
    ).stdout.trim();
  for (const space of ["space-a", "space-b"])
    await git("init", "--bare", "--initial-branch=main", `remote-${space}.git`);
  await mkdir(path.join(root, "quarantine"));
  const database = memoryDatabaseFake();
  const locks = new Map<string, ReturnType<typeof serialMemoryLock>>();
  const transports: GitTransport[] = [];
  const store = (
    spaceId = "space-a",
    machineId = "machine-a",
    mode: "publish" | "propose" = "publish",
  ) => {
    const key = `${spaceId}-${machineId}`;
    if (!locks.has(key)) locks.set(key, serialMemoryLock());
    const transport = new GitTransport({
      root: path.join(root, key),
      remote: {
        url: path.join(root, `remote-${spaceId}.git`),
        host: "fixture",
        protocol: "fixture",
      },
      allowFixtureRemote: true,
    });
    transports.push(transport);
    return new GitDocumentStore({
      transport,
      quarantine: new MarkdownFiles(path.join(root, "quarantine")),
      spaceId,
      machineId,
      branch: "main",
      mode,
      exclusive: locks.get(key)!,
    });
  };
  return {
    root,
    git,
    store,
    transports,
    companion: (spaceId: string) =>
      new VaultWithPrivateDocuments(store(spaceId), new PostgresDocumentStore(database.tx), null),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
memoryConformance("Git with private companion", async () => {
  const f = await fixture();
  return { store: f.companion, restart: () => undefined, dispose: f.dispose };
});
const access = { ...memoryTestAccess(), displayName: "Fixture member" };
const request = () => memoryTestCommit(access, "Shared fact", "space-shared");
describe("Git document store", () => {
  it("commits each save synchronously, restarts, pushes and exports history losslessly", async () => {
    const f = await fixture();
    try {
      const first = await f.store().commit(request(), access);
      expect(first.commitId).toMatch(/^[a-f0-9]{40}$/);
      expect(first.gitSync?.status).toBe("pending");
      expect(await f.store().read(first.id, access)).toEqual(first);
      await f.store().push(access);
      expect((await f.store().read(first.id, access))?.gitSync?.status).toBe("pushed");
      expect(await f.git("--git-dir=remote-space-a.git", "rev-parse", "main")).toBe(first.commitId);
      const other = f.store("space-a", "machine-b");
      await other.startSession(access);
      expect((await other.read(first.id, access))?.content).toBe("Shared fact");
      const exported = await other.exportBundle(access);
      expect(exported.documents[0]?.revisions[0]?.commitId).toBe(first.commitId);
      const third = f.store("space-a", "machine-c");
      await third.importBundle(exported, request().delivery, access);
      expect(await third.exportBundle(access)).toEqual(exported);
    } finally {
      await f.dispose();
    }
  });
  it("keeps both conflicting edits and handles push races between machines", async () => {
    const f = await fixture();
    try {
      const a = f.store();
      const b = f.store("space-a", "machine-b");
      const first = await a.commit(request(), access);
      await a.push(access);
      await b.startSession(access);
      await a.commit(
        { ...request(), id: first.id, expectedRevision: 1, content: "From A" },
        access,
      );
      await b.commit(
        { ...request(), id: first.id, expectedRevision: 1, content: "From B" },
        access,
      );
      await Promise.all([a.push(access), b.push(access)]);
      await a.startSession(access);
      const page = await a.list({}, access);
      expect(page.items.map((d) => d.content).sort()).toEqual(["From A", "From B"]);
      expect(page.items.some((d) => d.path.includes(".conflict-"))).toBe(true);
      expect((await a.exportBundle(access)).documents.every((d) => d.revisions.length === 2)).toBe(
        true,
      );
    } finally {
      await f.dispose();
    }
  });
  it("keeps proposal facts out of shared recall until their branch is merged", async () => {
    const f = await fixture();
    try {
      const store = f.store("space-a", "machine-a", "propose");
      const saved = await store.commit(request(), access);
      await store.push(access);
      expect((await store.list({}, access)).items).toHaveLength(1);
      expect((await store.list({}, { ...access, recall: true })).items).toHaveLength(0);
      const service = new MemoryService({
        enqueue: async () => undefined,
        open: async (context, action) =>
          action({
            store,
            access: { ...access, recall: context.memoryRecall },
            semantic: null,
            generation: 0,
          }),
      });
      expect(
        (await new LifecycleMemoryStore(service).read({ scope: "user" }, access)).documents,
      ).toHaveLength(0);
      const proposal = "ardur/proposals/space-a/machine-a";
      await f.git(
        "--git-dir=remote-space-a.git",
        "update-ref",
        "refs/heads/main",
        `refs/heads/${proposal}`,
      );
      await store.startSession(access);
      expect((await store.list({}, { ...access, recall: true })).items[0]?.id).toBe(saved.id);
    } finally {
      await f.dispose();
    }
  });
  it("rejects secret-shaped content before staging and never runs repository hooks", async () => {
    const f = await fixture();
    try {
      const store = f.store();
      await store.list({}, access);
      const marker = path.join(f.root, "hook-ran");
      await mkdir(path.join(f.root, "space-a-machine-a/clone/.git/hooks"), { recursive: true });
      await writeFile(
        path.join(f.root, "space-a-machine-a/clone/.git/hooks/pre-commit"),
        `#!/bin/sh\ntouch '${marker}'\n`,
        { mode: 0o700 },
      );
      const suspect = ["gh", "p_", "x".repeat(36)].join("");
      await expect(store.commit({ ...request(), content: suspect }, access)).rejects.toThrow(
        "credentials",
      );
      expect(await readdir(path.join(f.root, "quarantine"))).toHaveLength(1);
      expect((await store.list({}, access)).items).toHaveLength(0);
      await store.commit(request(), access);
      await store.push(access);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.dispose();
    }
  });
  it("retains an offline commit when the remote disconnects during push and retries it", async () => {
    const f = await fixture();
    try {
      const store = f.store();
      const saved = await store.commit(request(), access);
      const transport = f.transports.at(-1)!;
      const push = transport.push.bind(transport);
      const remote = path.join(f.root, "remote-space-a.git");
      vi.spyOn(transport, "push").mockImplementationOnce(async (...args) => {
        await rename(remote, `${remote}.offline`);
        return push(...args);
      });
      await expect(store.push(access)).rejects.toThrow("Saved locally");
      const local = await store.read(saved.id, access);
      expect(local?.commitId).toBe(saved.commitId);
      expect(local?.gitSync?.status).toBe("failed");
      await rename(`${remote}.offline`, remote);
      await store.push(access);
      expect((await store.read(saved.id, access))?.gitSync?.status).toBe("pushed");
    } finally {
      await f.dispose();
    }
  });
  it("quarantines a rewritten remote without losing offline or published history", async () => {
    const f = await fixture();
    try {
      const store = f.store();
      const original = await store.commit(request(), access);
      await store.push(access);
      const offline = await store.commit(
        { ...request(), id: original.id, expectedRevision: 1, content: "Still local" },
        access,
      );
      const transport = f.transports.at(-1)!;
      const tree = await f.git("--git-dir=remote-space-a.git", "rev-parse", "main^{tree}");
      const replacement = (
        await transport.run(["commit-tree", tree], {
          input: "Replace fixture history.\n",
          env: {
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@memory.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@memory.invalid",
          },
        })
      ).trim();
      await transport.run([
        "push",
        "--force",
        "--",
        path.join(f.root, "remote-space-a.git"),
        `${replacement}:refs/heads/main`,
      ]);
      await store.startSession(access);
      expect((await store.syncState(access)).status).toBe("quarantined");
      expect((await store.read(original.id, access))?.commitId).toBe(offline.commitId);
      expect((await store.exportBundle(access)).documents[0]?.revisions).toHaveLength(2);
      expect(
        (await readdir(path.join(f.root, "quarantine"))).some((name) =>
          name.startsWith("repository-"),
        ),
      ).toBe(true);
      await expect(store.commit({ ...request(), path: "new.md" }, access)).rejects.toThrow(
        "history changed",
      );
      await expect(store.push(access)).rejects.toThrow();
    } finally {
      await f.dispose();
    }
  });
  it("continues with the last local copy when the session pull reaches its deadline", async () => {
    const f = await fixture();
    try {
      const store = f.store();
      const saved = await store.commit(request(), access);
      const transport = f.transports.at(-1)!;
      vi.spyOn(transport, "fetch").mockImplementation(
        async (_branch, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
          }),
      );
      const began = Date.now();
      await store.startSession(access, 30);
      expect(Date.now() - began).toBeLessThan(1000);
      expect((await store.syncState(access)).status).toBe("last-copy");
      expect((await store.read(saved.id, access))?.content).toBe("Shared fact");
    } finally {
      await f.dispose();
    }
  });
  it("restores shared tombstones and keeps commit provenance when moved to built-in storage", async () => {
    const f = await fixture();
    try {
      const store = f.store();
      const first = await store.commit(request(), access);
      await store.delete(first.id, 1, request(), access);
      expect((await store.list({}, access)).items).toHaveLength(0);
      await store.restore(first.id, 1, 2, request(), access);
      const bundle = await store.exportBundle(access);
      const database = memoryDatabaseFake();
      const postgres = new PostgresDocumentStore(database.tx);
      await postgres.importBundle(bundle, request().delivery, access);
      expect(await postgres.exportBundle(access)).toEqual(bundle);
      expect(bundle.documents[0]?.revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    } finally {
      await f.dispose();
    }
  });

  it("never stages unrelated files or executes attribute filters and queues only after the commit", async () => {
    const f = await fixture();
    try {
      const store = f.store();
      await store.list({}, access);
      const transport = f.transports.at(-1)!;
      const marker = path.join(f.root, "filter-ran");
      await writeFile(path.join(transport.files.root, ".gitattributes"), "*.md filter=fixture\n");
      await writeFile(
        path.join(transport.files.root, ".git/config"),
        `[core]\nrepositoryformatversion = 0\nbare = false\n[filter "fixture"]\nclean = touch '${marker}'\nsmudge = touch '${marker}'\n`,
      );
      await writeFile(path.join(transport.files.root, "unrelated-cache"), "Unrelated content");
      const enqueueGit = vi.fn(async () => {
        expect((await store.list({}, access)).items[0]?.commitId).toBeTruthy();
      });
      const service = new MemoryService({
        enqueue: async () => undefined,
        enqueueGit,
        open: async (_context, action) => action({ store, access, semantic: null, generation: 3 }),
      });
      const saved = await service.save(
        { scope: "space-shared", path: "queued.md", content: "Durable before queue" },
        access,
      );
      expect(enqueueGit).toHaveBeenCalledWith(expect.objectContaining({ memoryGeneration: 3 }));
      const files = await transport.run(["ls-tree", "-r", "--name-only", saved.commitId!]);
      expect(files).not.toContain("unrelated-cache");
      expect(files).not.toContain(".gitattributes");
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(path.join(transport.options.root, "state.json"));
      expect((await f.store().syncState(access)).status).toBe("pending");
    } finally {
      await f.dispose();
    }
  });

  it("reconciles a remote Markdown edit by content hash and preserves it in portable history", async () => {
    const f = await fixture();
    try {
      const store = f.store();
      const saved = await store.commit(request(), access);
      await store.push(access);
      const transport = f.transports.at(-1)!;
      const note = (
        await transport.run(["ls-tree", "-r", "--name-only", saved.commitId!, "--", "memories"])
      ).trim();
      const raw = await transport.files.read(note);
      const revision = parseRevisionMarkdown(raw!);
      revision.content = "Edited on the remote";
      const blob = (
        await transport.run(["hash-object", "-w", "--stdin"], { input: revisionMarkdown(revision) })
      ).trim();
      await transport.run(["read-tree", saved.commitId!]);
      await transport.run(["update-index", "--cacheinfo", "100644", blob, note]);
      const tree = (await transport.run(["write-tree"])).trim();
      const next = (
        await transport.run(["commit-tree", tree, "-p", saved.commitId!], {
          input: "Edit the fixture note.\n",
          env: {
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@memory.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@memory.invalid",
          },
        })
      ).trim();
      await transport.push(next, "main", AbortSignal.timeout(5000));
      await store.startSession(access);
      expect(await store.read(saved.id, access)).toMatchObject({
        content: "Edited on the remote",
        revision: 2,
        commitId: next,
      });
      await store.commit(
        { ...request(), id: saved.id, expectedRevision: 2, content: "Edited locally afterwards" },
        access,
      );
      expect((await f.store().history(saved.id, {}, access)).items.map((r) => r.content)).toEqual([
        "Edited locally afterwards",
        "Edited on the remote",
        "Shared fact",
      ]);
    } finally {
      await f.dispose();
    }
  });
  it("rejects executable hooks supplied by a remote without running or checking them out", async () => {
    const f = await fixture();
    try {
      const store = f.store();
      const saved = await store.commit(request(), access);
      await store.push(access);
      const transport = f.transports.at(-1)!;
      const marker = path.join(f.root, "remote-hook-ran");
      const blob = (
        await transport.run(["hash-object", "-w", "--stdin"], {
          input: `#!/bin/sh\ntouch '${marker}'\n`,
        })
      ).trim();
      await transport.run(["read-tree", saved.commitId!]);
      await transport.run([
        "update-index",
        "--add",
        "--cacheinfo",
        "100755",
        blob,
        ".githooks/post-checkout",
      ]);
      const tree = (await transport.run(["write-tree"])).trim();
      const next = (
        await transport.run(["commit-tree", tree, "-p", saved.commitId!], {
          input: "Add an unsafe fixture hook.\n",
          env: {
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@memory.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@memory.invalid",
          },
        })
      ).trim();
      await transport.push(next, "main", AbortSignal.timeout(5000));
      await store.startSession(access);
      expect((await store.syncState(access)).status).toBe("last-copy");
      expect((await store.read(saved.id, access))?.commitId).toBe(saved.commitId);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        readFile(path.join(transport.files.root, ".githooks/post-checkout")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await f.dispose();
    }
  });
});
