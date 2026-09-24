import { randomUUID } from "node:crypto";
import { cp, rm } from "node:fs/promises";
import path from "node:path";
import type {
  DocumentCommit,
  DocumentRevision,
  MemoryAccess,
  MemoryDocumentHead,
  MemoryDocumentStore,
  MemorySyncState,
} from "@ardurbot/adapter-kit";
import { MemoryAccessError } from "@ardurbot/adapter-kit";
import type { JournalDocument, MemoryJournal } from "@ardurbot/memory";
import {
  assertMemorySafe,
  JournalDocumentStore,
  MemoryRedactionError,
  parseBundle,
} from "@ardurbot/memory";
import type { GitLocalState, GitSnapshot, GitSyncRepository } from "./git-sync.js";
import { pullGitMemory, pushGitMemory, reconcileGitDocuments, revisionHash } from "./git-sync.js";
import type { GitTransport } from "./git-transport.js";
import { GitOperationError, validateGitBranch } from "./git-transport.js";
import type { MarkdownFiles } from "./markdown-files.js";
import {
  contentHash,
  historyNotePath,
  parseRevisionMarkdown,
  revisionMarkdown,
} from "./markdown-files.js";
import { vaultNotePath } from "./obsidian-store.js";

// An allowlist, not a collection of patterns that might miss a new cache/credential format.
export const GIT_MEMORY_IGNORE =
  "*\n!/.gitignore\n!/memories/\n!/memories/space-shared/\n!/memories/space-shared/*.md\n!/history/\n!/history/*/\n!/history/*/*.md\n";
export interface GitStoreOptions {
  transport: GitTransport;
  quarantine: MarkdownFiles;
  spaceId: string;
  machineId: string;
  branch: string;
  mode: "publish" | "propose";
  clock?: () => Date;
  knownSecrets?: () => Promise<readonly string[]>;
  exclusive<T>(action: () => Promise<T>): Promise<T>;
}
function identity(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,160}$/u.test(value)) throw new MemoryAccessError();
  return value;
}
function allowedFile(name: string): boolean {
  return (
    name === ".gitignore" ||
    /^memories\/space-shared\/[a-zA-Z0-9_.-]+\.md$/u.test(name) ||
    /^history\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\.md$/u.test(name)
  );
}
function prefix(access: MemoryAccess, machine: string): string {
  return `${identity(access.userId)}-${identity(machine)}`;
}
export function gitNotePath(revision: DocumentRevision, writer: string): string {
  const standard = vaultNotePath(revision);
  return `${path.posix.dirname(standard)}/${writer}-${path.posix.basename(standard)}`;
}
class GitJournal implements MemoryJournal, GitSyncRepository {
  readonly transport: GitTransport;
  readonly branch: string;
  readonly targetBranch: string;
  readonly machineId: string;
  private initialized = false;
  private readonly placements = new Map<string, string>();
  constructor(readonly options: GitStoreOptions) {
    identity(options.spaceId);
    identity(options.machineId);
    this.transport = options.transport;
    this.branch = validateGitBranch(options.branch);
    this.machineId = options.machineId;
    this.targetBranch =
      options.mode === "publish"
        ? this.branch
        : `ardur/proposals/${options.spaceId}/${options.machineId}`;
    const relative = path.relative(this.transport.files.root, options.quarantine.root);
    if (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    )
      throw new Error("Quarantine must be outside the repository.");
  }
  private get ref() {
    return `refs/heads/${this.targetBranch}`;
  }
  private async initialize() {
    if (!this.initialized) {
      await this.transport.initialize();
      await this.transport.run(["symbolic-ref", "HEAD", this.ref]);
      if ((await this.transport.files.read(".gitignore")) === null)
        await this.transport.files.write(".gitignore", GIT_MEMORY_IGNORE);
      this.initialized = true;
    }
  }
  async state(): Promise<GitLocalState> {
    await this.initialize();
    const raw = await this.transport.control.read("state.json");
    if (!raw) return { version: 1, remote: {}, status: "ready", quarantined: false, delivery: {} };
    const state = JSON.parse(raw) as GitLocalState;
    if (state.version !== 1 || !state.remote || !state.delivery) throw new GitOperationError();
    return state;
  }
  async saveState(state: GitLocalState) {
    await this.transport.control.write("state.json", JSON.stringify(state));
  }
  async quarantine(state: GitLocalState) {
    // Keep the complete object database, including all offline commits, outside the active clone.
    const destination = await this.options.quarantine.resolve(`repository-${randomUUID()}`, true);
    await cp(this.transport.files.root, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    state.quarantined = true;
    state.status = "quarantined";
    await this.saveState(state);
  }
  private async head(signal?: AbortSignal): Promise<string | null> {
    try {
      return (await this.transport.run(["rev-parse", "--verify", this.ref], { signal })).trim();
    } catch (error) {
      if (error instanceof GitOperationError && error.code === 128) return null;
      throw error;
    }
  }
  async snapshot(oid?: string | null, signal?: AbortSignal): Promise<GitSnapshot> {
    await this.initialize();
    const selected = oid === undefined ? await this.head(signal) : oid;
    if (!selected) return { oid: null, documents: [], files: new Map() };
    const tree = await this.transport.run(["ls-tree", "-r", "-z", selected], { signal });
    const files = new Map<string, string>();
    const knownSecrets = (await this.options.knownSecrets?.()) ?? [];
    const entries = tree
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(100644) blob ([a-f0-9]+)\t(.+)$/u.exec(entry);
        if (!match || !allowedFile(match[3]!))
          throw new Error("Use a dedicated memory repository with regular Markdown files.");
        return { oid: match[2]!, name: match[3]! };
      });
    const batch = Buffer.from(
      await this.transport.run(["cat-file", "--batch"], {
        input: entries.map((entry) => `${entry.oid}\n`).join(""),
        signal,
      }),
    );
    let offset = 0;
    for (const { name, oid: blobId } of entries) {
      const headerEnd = batch.indexOf(10, offset);
      const header = batch.subarray(offset, headerEnd).toString("utf8").split(" ");
      const size = Number(header[2]);
      if (
        header[0] !== blobId ||
        header[1] !== "blob" ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        headerEnd < offset ||
        headerEnd + size + 1 >= batch.length
      )
        throw new GitOperationError();
      const raw = batch.subarray(headerEnd + 1, headerEnd + 1 + size).toString("utf8");
      offset = headerEnd + size + 2;
      try {
        assertMemorySafe({ name, raw }, knownSecrets);
      } catch {
        await this.options.quarantine.write(`${contentHash(raw)}.txt`, raw, false);
        throw new MemoryRedactionError();
      }
      files.set(name, raw);
    }
    if (files.get(".gitignore") !== GIT_MEMORY_IGNORE)
      throw new Error("The memory repository ignore rules changed. Review them before continuing.");
    // Git history supplies commit identity even if app-private status files were lost on restart.
    const log = await this.transport.run(
      [
        "log",
        "--reverse",
        "--format=COMMIT:%H",
        "--name-only",
        "--diff-filter=A",
        selected,
        "--",
        "history",
        "memories",
      ],
      { signal },
    );
    const commits = new Map<string, string>();
    let commit = "";
    for (const line of log.split("\n")) {
      if (line.startsWith("COMMIT:")) commit = line.slice(7);
      else if (line && !commits.has(line)) commits.set(line, commit);
    }
    const docs = new Map<string, JournalDocument>();
    const state = await this.state();
    for (const [name, raw] of files) {
      if (!name.startsWith("history/")) continue;
      const revision = parseRevisionMarkdown(raw);
      this.assertShared(revision);
      if (name.split("/")[1] !== revision.documentId) throw new MemoryAccessError();
      revision.commitId ??= commits.get(name);
      if (commits.get(name))
        this.placements.set(`${revision.documentId}:${revision.revision}`, commits.get(name)!);
      let doc = docs.get(revision.documentId);
      if (!doc) {
        doc = {
          id: revision.documentId,
          revisions: [],
          delivery: state.delivery[revision.documentId] ?? {
            status: "delivered",
            provider: null,
            generation: 0,
          },
        };
        docs.set(doc.id, doc);
      }
      const existing = doc.revisions.find((r) => r.revision === revision.revision);
      if (existing && revisionHash(existing) !== revisionHash(revision))
        throw new Error("Conflicting revision files need review.");
      if (!existing) doc.revisions.push(revision);
    }
    for (const doc of docs.values()) doc.revisions.sort((a, b) => a.revision - b.revision);
    // A teammate can edit the ordinary Markdown note. Compare content, never mtimes.
    for (const [name, raw] of files) {
      if (!name.startsWith("memories/")) continue;
      const edited = parseRevisionMarkdown(raw);
      this.assertShared(edited);
      const doc = docs.get(edited.documentId);
      if (!doc) throw new Error("This repository note is missing its history.");
      if (doc.revisions.some((r) => revisionHash(r) === revisionHash(edited))) continue;
      if (
        doc.revisions.some(
          (r) =>
            r.revision === edited.revision + 1 &&
            r.content === edited.content &&
            JSON.stringify(r.references) === JSON.stringify(edited.references) &&
            r.path === edited.path &&
            r.deletedAt === edited.deletedAt,
        )
      )
        continue;
      const head = doc.revisions.at(-1)!;
      if (edited.path !== head.path || edited.revision > head.revision)
        throw new Error("Conflicting note edits need review.");
      const metadata = (
        await this.transport.run(["log", "-1", "--format=%H%n%cI", selected, "--", name], {
          signal,
        })
      )
        .trim()
        .split("\n");
      const external = {
        ...edited,
        revision: edited.revision + 1,
        createdAt: new Date(
          Math.max(Date.parse(head.createdAt), Date.parse(metadata[1]!)),
        ).toISOString(),
        commitId: metadata[0],
        model: null,
        runId: null,
        threadId: null,
      };
      if (edited.revision === head.revision && !head.deletedAt) {
        this.placements.set(`${doc.id}:${external.revision}`, metadata[0]!);
        doc.revisions.push(external);
      } else {
        // Deterministic identity makes a repeatedly fetched stale edit the same retained sibling.
        const id = contentHash(`${name}\n${raw}`).slice(0, 32);
        const conflictPath = `${head.path.replace(/\.md$/iu, "").slice(0, 400)}.conflict-${id}.md`;
        const revisions = [
          ...doc.revisions.filter((r) => r.revision <= edited.revision),
          external,
        ].map((r) => ({ ...r, documentId: id, path: conflictPath }));
        docs.set(id, { ...doc, id, revisions });
        this.placements.set(`${id}:${external.revision}`, metadata[0]!);
      }
    }
    const documents = [...docs.values()].sort((a, b) => a.id.localeCompare(b.id));
    parseBundle({
      version: 1,
      documents: documents.map(({ id, revisions }) => ({ id, revisions })),
    });
    return { oid: selected, documents, files };
  }
  private assertShared(revision: DocumentRevision) {
    if (
      revision.scopeKey.kind !== "space-shared" ||
      revision.scopeKey.spaceId !== this.options.spaceId
    )
      throw new MemoryAccessError();
  }
  private async writeTree(
    files: Map<string, string>,
    base: GitSnapshot,
    parents: string[],
    access: MemoryAccess,
    sentence: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const existingIgnore = await this.transport.files.read(".gitignore");
    if (existingIgnore !== null && existingIgnore !== GIT_MEMORY_IGNORE)
      throw new Error("The memory repository ignore rules changed. Review them before continuing.");
    files.set(".gitignore", GIT_MEMORY_IGNORE);
    const touched = [...files].filter(([name, raw]) => base.files.get(name) !== raw);
    const removed = [...base.files.keys()].filter((name) => !files.has(name));
    // Scan all bytes before creating an index. No untrusted path ever reaches Git's argv.
    for (const [name, raw] of files) {
      if (!allowedFile(name)) throw new MemoryAccessError();
      assertMemorySafe({ name, raw }, access.knownSecrets);
    }
    const index = path.join(this.transport.options.root, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.transport.run(base.oid ? ["read-tree", base.oid] : ["read-tree", "--empty"], {
        env,
        signal,
      });
      for (const name of removed)
        await this.transport.run(["update-index", "--force-remove", "--", name], { env, signal });
      for (const [name, raw] of touched) {
        await this.transport.files.write(name, raw);
        const blob = (
          await this.transport.run(["hash-object", "-w", "--no-filters", "--stdin"], {
            input: raw,
            signal,
          })
        ).trim();
        await this.transport.run(["update-index", "--add", "--cacheinfo", "100644", blob, name], {
          env,
          signal,
        });
      }
      const staged = (
        await this.transport.run(
          ["diff", "--cached", "--name-only", "-z", ...(base.oid ? [base.oid] : [])],
          { env, signal },
        )
      )
        .split("\0")
        .filter(Boolean);
      const expected = new Set([...touched.map(([name]) => name), ...removed]);
      if (staged.some((name) => !expected.has(name))) throw new MemoryAccessError();
      const tree = (await this.transport.run(["write-tree"], { env, signal })).trim();
      const name =
        (access.displayName ?? "Space member")
          .replace(/[<>\r\n\0]/gu, " ")
          .slice(0, 100)
          .trim() || "Space member";
      assertMemorySafe(name, access.knownSecrets);
      const email = `${contentHash(this.options.spaceId).slice(0, 24)}@memory.invalid`;
      const oid = (
        await this.transport.run(
          ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent])],
          {
            input: `${sentence}\n`,
            signal,
            env: {
              GIT_AUTHOR_NAME: name,
              GIT_AUTHOR_EMAIL: email,
              GIT_COMMITTER_NAME: name,
              GIT_COMMITTER_EMAIL: email,
            },
          },
        )
      ).trim();
      await this.transport.run(["update-ref", this.ref, oid, base.oid ?? "0".repeat(40)], {
        signal,
      });
      for (const removedPath of removed) await this.transport.files.remove(removedPath);
      return oid;
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }
  private projectDocuments(
    documents: JournalDocument[],
    files: Map<string, string>,
    access: MemoryAccess,
  ) {
    const writer = prefix(access, this.machineId);
    const recorded = new Set(
      [...files]
        .filter(([name]) => name.startsWith("history/"))
        .map(([, raw]) => {
          const revision = parseRevisionMarkdown(raw);
          return `${revision.documentId}:${revision.revision}:${revisionHash(revision)}`;
        }),
    );
    for (const doc of documents) {
      for (const revision of doc.revisions) {
        this.assertShared(revision);
        if (!recorded.has(`${doc.id}:${revision.revision}:${revisionHash(revision)}`))
          files.set(historyNotePath(revision, writer), revisionMarkdown(revision));
      }
      const head = doc.revisions.at(-1)!;
      // Each writer owns its note path. Tombstones stay in portable history.
      const note = gitNotePath(head, writer);
      if (head.deletedAt) files.delete(note);
      else files.set(note, revisionMarkdown(head));
    }
  }
  private async writeLocalIndex(documents: JournalDocument[], files: Map<string, string>) {
    const notes = [...files]
      .filter(([name]) => name.startsWith("memories/space-shared/"))
      .map(([name, raw]) => ({ name, revision: parseRevisionMarkdown(raw) }));
    const lines = documents
      .map((doc) => doc.revisions.at(-1)!)
      .filter((head) => !head.deletedAt)
      .map((head) => {
        const note = notes
          .filter((entry) => entry.revision.documentId === head.documentId)
          .sort((a, b) => b.revision.revision - a.revision.revision)[0];
        return note ? `- [[${note.name}|${head.path.replace(/[[\]|\r\n]/gu, " ")}]]` : "";
      })
      .filter(Boolean);
    await this.transport.files.ensureDirectory("concepts");
    await this.transport.files.ensureDirectory("reference");
    await this.transport.files.write("memories/MEMORY.md", `# Memory\n\n${lines.join("\n")}\n`);
  }
  async integrate(remote: GitSnapshot, access: MemoryAccess, signal: AbortSignal) {
    if (!remote.oid) return;
    const local = await this.snapshot(undefined, signal);
    if (
      local.oid === remote.oid ||
      (local.oid && (await this.transport.ancestor(remote.oid, local.oid, signal)))
    )
      return;
    if (!local.oid || (await this.transport.ancestor(local.oid, remote.oid, signal))) {
      await this.transport.run(["update-ref", this.ref, remote.oid, local.oid ?? "0".repeat(40)], {
        signal,
      });
      for (const [name, raw] of remote.files) await this.transport.files.write(name, raw);
      await this.writeLocalIndex(remote.documents, remote.files).catch(() => undefined);
      return;
    }
    const documents = reconcileGitDocuments(remote.documents, local.documents, this.machineId);
    const files = new Map(remote.files);
    this.projectDocuments(documents, files, access);
    await this.writeTree(
      files,
      local,
      [local.oid, remote.oid],
      access,
      "Preserve both memory histories.",
      signal,
    );
    await this.writeLocalIndex(documents, files).catch(() => undefined);
  }
  async transaction<T>(
    access: MemoryAccess,
    action: (documents: JournalDocument[]) => Promise<T>,
  ): Promise<T> {
    if (access.spaceId !== this.options.spaceId) throw new MemoryAccessError();
    access = {
      ...access,
      knownSecrets: [
        ...(access.knownSecrets ?? []),
        ...((await this.options.knownSecrets?.()) ?? []),
      ],
    };
    return this.options.exclusive(async () => {
      const state = await this.state();
      const snapshot = await this.snapshot(
        access.recall && this.options.mode === "propose"
          ? (state.remote[this.branch] ?? null)
          : undefined,
      );
      const documents = structuredClone(snapshot.documents);
      const result = await action(documents);
      const changed = documents.filter(
        (doc) =>
          JSON.stringify(doc.revisions) !==
          JSON.stringify(snapshot.documents.find((old) => old.id === doc.id)?.revisions),
      );
      if (changed.length) {
        if (state.quarantined || access.recall)
          throw new Error("Repository history changed. Review the saved copy before continuing.");
        for (const doc of documents)
          for (const revision of doc.revisions) {
            this.assertShared(revision);
            assertMemorySafe(revision, access.knownSecrets);
          }
        const files = new Map(snapshot.files);
        this.projectDocuments(changed, files, access);
        const oid = await this.writeTree(
          files,
          snapshot,
          snapshot.oid ? [snapshot.oid] : [],
          access,
          "Save shared memory.",
        );
        await this.writeLocalIndex(documents, files).catch(() => undefined);
        state.status = "pending";
        for (const doc of changed)
          for (const revision of doc.revisions)
            if (!this.placements.has(`${doc.id}:${revision.revision}`))
              this.placements.set(`${doc.id}:${revision.revision}`, oid);
        // Return the accepted commit's identity without creating a second commit to store its hash.
        if (result && typeof result === "object" && "documentId" in result)
          Object.assign(result, { commitId: oid });
      }
      for (const doc of documents) state.delivery[doc.id] = doc.delivery;
      if (!access.recall && (changed.length || documents.length)) await this.saveState(state);
      return result;
    });
  }
  async status(): Promise<MemorySyncState> {
    const state = await this.state();
    const head = await this.head();
    const status =
      state.status === "ready" && head && head !== state.remote[this.targetBranch]
        ? "pending"
        : state.status;
    return {
      host: this.transport.options.remote.host,
      status,
      branch: this.branch,
      proposalBranch: this.options.mode === "propose" ? this.targetBranch : null,
    };
  }
  async revisionStatus(id: string, revision: number) {
    const commitId = this.placements.get(`${id}:${revision}`);
    const state = await this.state();
    const remote = state.remote[this.targetBranch];
    const pushed =
      commitId && remote && (await this.transport.ancestor(commitId, remote).catch(() => false));
    return {
      status: pushed
        ? ("pushed" as const)
        : state.status === "failed"
          ? ("failed" as const)
          : ("pending" as const),
      branch: this.targetBranch,
    };
  }
}
/** P1a owns history, restore, deletion and portable import/export. Git is its durable journal. */
export class GitDocumentStore extends JournalDocumentStore {
  private readonly gitJournal: GitJournal;
  constructor(private readonly options: GitStoreOptions) {
    const journal = new GitJournal(options);
    super(journal, "git", options.clock);
    this.gitJournal = journal;
  }
  override describe(): ReturnType<MemoryDocumentStore["describe"]> {
    return {
      ...super.describe(),
      capabilities: { network: "remote", revisions: true, portable: true },
    };
  }
  private async decorated(doc: MemoryDocumentHead): Promise<MemoryDocumentHead> {
    return { ...doc, gitSync: await this.gitJournal.revisionStatus(doc.id, doc.revision) };
  }
  override async commit(input: DocumentCommit, access: MemoryAccess) {
    try {
      return await this.decorated(await super.commit(input, access));
    } catch (error) {
      if (error instanceof MemoryRedactionError)
        await this.options.quarantine.write(`${randomUUID()}.txt`, JSON.stringify(input), false);
      throw error;
    }
  }
  override async read(...args: Parameters<MemoryDocumentStore["read"]>) {
    const doc = await super.read(...args);
    return doc ? this.decorated(doc) : null;
  }
  override async list(...args: Parameters<MemoryDocumentStore["list"]>) {
    const page = await super.list(...args);
    return { ...page, items: await Promise.all(page.items.map((doc) => this.decorated(doc))) };
  }
  override async delete(...args: Parameters<MemoryDocumentStore["delete"]>) {
    return this.decorated(await super.delete(...args));
  }
  override async restore(...args: Parameters<MemoryDocumentStore["restore"]>) {
    return this.decorated(await super.restore(...args));
  }
  override async history(...args: Parameters<MemoryDocumentStore["history"]>) {
    const page = await super.history(...args);
    return {
      ...page,
      items: await Promise.all(
        page.items.map(async (revision) => ({
          ...revision,
          gitSync: await this.gitJournal.revisionStatus(revision.documentId, revision.revision),
        })),
      ),
    };
  }
  startSession(access: MemoryAccess, deadlineMs?: number) {
    if (access.spaceId !== this.options.spaceId) throw new MemoryAccessError();
    return this.options.exclusive(() => pullGitMemory(this.gitJournal, access, deadlineMs));
  }
  push(access: MemoryAccess) {
    if (access.spaceId !== this.options.spaceId) throw new MemoryAccessError();
    return this.options.exclusive(() => pushGitMemory(this.gitJournal, access));
  }
  syncState(access: MemoryAccess) {
    if (access.spaceId !== this.options.spaceId) throw new MemoryAccessError();
    return this.gitJournal.status();
  }
}
