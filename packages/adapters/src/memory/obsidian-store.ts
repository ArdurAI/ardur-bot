import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  DocumentRevision,
  MemoryAccess,
  MemoryBundle,
  MemoryDocumentHead,
  MemoryDocumentStore,
} from "@ardurbot/adapter-kit";
import { MemoryAccessError, MemoryConflictError } from "@ardurbot/adapter-kit";
import { DocumentDeliverySchema } from "@ardurbot/contracts";
import type { JournalDocument, MemoryJournal } from "@ardurbot/memory";
import {
  assertMemorySafe,
  JournalDocumentStore,
  parseBundle,
  previewImport,
  requireImportReady,
  scopeKey,
} from "@ardurbot/memory";
import {
  contentHash,
  historyNotePath,
  type MarkdownFiles,
  parseRevisionMarkdown,
  revisionMarkdown,
} from "./markdown-files.js";

const JOURNAL = ".ardur-memory.json";
interface VaultState {
  version: 1;
  spaceId: string;
  ownerUserId: string;
  documents: JournalDocument[];
  published: Record<string, string>;
}
export function vaultNotePath(revision: DocumentRevision): string {
  const slug =
    revision.path
      .replace(/\.md$/iu, "")
      .replace(/[^a-zA-Z0-9_-]+/gu, "-")
      .slice(0, 80) || "note";
  return `memories/${revision.scopeKey.kind}/${slug}-${revision.documentId}.md`;
}
export interface ObsidianStoreOptions {
  files: MarkdownFiles;
  quarantine: MarkdownFiles;
  spaceId: string;
  ownerUserId: string;
  clock?: () => Date;
  /** API and worker use the same database advisory lock; tests inject a deterministic mutex. */
  exclusive<T>(action: () => Promise<T>): Promise<T>;
}
class ObsidianJournal implements MemoryJournal {
  private readonly now: () => Date;
  constructor(private readonly options: ObsidianStoreOptions) {
    this.now = options.clock ?? (() => new Date());
    const relative = path.relative(options.files.root, options.quarantine.root);
    if (
      !relative ||
      (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    )
      throw new Error("Quarantine must be outside the selected folder.");
  }
  private allowed(revision: DocumentRevision): boolean {
    const scope = revision.scopeKey;
    return (
      scope.spaceId === this.options.spaceId &&
      (scope.kind === "space-shared" ||
        (scope.kind === "user" && scope.userId === this.options.ownerUserId))
    );
  }
  private async load(): Promise<VaultState> {
    const raw = await this.options.files.read(JOURNAL);
    if (!raw)
      return {
        version: 1,
        spaceId: this.options.spaceId,
        ownerUserId: this.options.ownerUserId,
        documents: [],
        published: {},
      };
    try {
      assertMemorySafe(raw);
    } catch {
      await this.options.quarantine.write(`${contentHash(raw)}.txt`, raw, false);
      await this.options.files.remove(JOURNAL, raw);
      // A missing manifest must not turn retained notes into an empty, writable store.
      await this.options.files.write(JOURNAL, JSON.stringify({ quarantined: true }));
      throw new Error(
        "This memory journal was quarantined. Restore a safe backup before continuing.",
      );
    }
    const state = JSON.parse(raw) as VaultState;
    if (
      state.version !== 1 ||
      state.spaceId !== this.options.spaceId ||
      state.ownerUserId !== this.options.ownerUserId
    )
      throw new MemoryAccessError();
    const bundle = parseBundle({
      version: 1,
      documents: state.documents.map(({ id, revisions }) => ({ id, revisions })),
    });
    for (const doc of bundle.documents)
      if (!doc.revisions.every((r) => this.allowed(r))) throw new MemoryAccessError();
    for (const doc of state.documents) DocumentDeliverySchema.parse(doc.delivery);
    if (!state.published || typeof state.published !== "object")
      throw new Error("Invalid memory journal.");
    return state;
  }
  private async publish(state: VaultState, observed: Map<string, string | null>): Promise<void> {
    const files = this.options.files;
    const writeChanged = async (name: string, content: string) => {
      const existing = await files.read(name);
      if (existing !== content) await files.write(name, content, true, existing);
    };
    await files.ensureDirectory("concepts");
    await files.ensureDirectory("reference");
    for (const doc of state.documents) {
      const head = doc.revisions.at(-1)!;
      const notePath = vaultNotePath(head);
      // The durable manifest precedes projections. Restart repairs missing/old projections.
      for (const revision of doc.revisions) {
        const history = historyNotePath(revision);
        const expected = revisionMarkdown(revision);
        const existing = await files.read(history);
        if (existing && existing !== expected) {
          try {
            assertMemorySafe(existing);
            await files.write(`history/${doc.id}/conflict-${randomUUID()}.md`, existing);
          } catch {
            await this.options.quarantine.write(`${contentHash(existing)}.txt`, existing, false);
            await files.remove(history);
          }
        }
        if (existing !== expected)
          await files.write(history, expected, true, await files.read(history));
      }
      const previous = observed.has(notePath) ? observed.get(notePath)! : null;
      if (head.deletedAt) await files.remove(notePath, previous);
      else if (previous !== revisionMarkdown(head))
        await files.write(notePath, revisionMarkdown(head), true, previous);
      observed.set(notePath, head.deletedAt ? null : revisionMarkdown(head));
      if (head.runId && head.author.botId) {
        const links = head.references.map((reference) => `- ${reference}`).join("\n");
        await writeChanged(
          `sessions/${head.author.botId}/${head.runId}-${doc.id}.md`,
          `# Evidence\n\n- Document: [[${notePath}]]\n- Run: ${head.runId}\n${links}\n`,
        );
      }
      state.published[notePath] = head.deletedAt ? "deleted" : contentHash(revisionMarkdown(head));
    }
    const index = state.documents
      .map((doc) => doc.revisions.at(-1)!)
      .filter((r) => !r.deletedAt)
      .map((r) => `- [[${vaultNotePath(r)}|${r.path.replace(/[[\]|\r\n]/gu, " ")}]]`)
      .join("\n");
    await writeChanged("memories/MEMORY.md", `# Memory\n\n${index}\n`);
    await writeChanged(JOURNAL, JSON.stringify(state));
  }
  private async persist(state: VaultState, observed: Map<string, string | null>) {
    if ((await this.options.files.read(JOURNAL)) !== JSON.stringify(state))
      await this.options.files.write(JOURNAL, JSON.stringify(state));
    await this.publish(state, observed);
  }
  private async reconcile(
    state: VaultState,
    access: MemoryAccess,
    observed: Map<string, string | null>,
  ): Promise<void> {
    for (const doc of state.documents) {
      const head = doc.revisions.at(-1)!;
      const notePath = vaultNotePath(head);
      const raw = await this.options.files.read(notePath);
      observed.set(notePath, raw);
      const expected = revisionMarkdown(head);
      if (raw === expected || (head.deletedAt && raw === null)) continue;
      // A missing projection or a projection from a committed older revision is repaired.
      if (raw === null) {
        if (state.published[notePath] === contentHash(expected)) {
          const timestamp = this.now().toISOString();
          doc.revisions.push({
            ...head,
            content: "",
            revision: head.revision + 1,
            createdAt: timestamp,
            deletedAt: timestamp,
            author: { kind: "user", userId: this.options.ownerUserId },
            model: null,
            runId: null,
            threadId: null,
          });
          if (doc.delivery.provider) doc.delivery.status = "pending";
        }
        continue;
      }
      if (
        contentHash(raw) === state.published[notePath] &&
        contentHash(raw) !== contentHash(expected)
      )
        continue;
      let edited: DocumentRevision;
      try {
        assertMemorySafe({ path: notePath, raw }, access.knownSecrets);
        edited = parseRevisionMarkdown(raw);
        if (
          edited.documentId !== doc.id ||
          scopeKey(edited.scopeKey) !== scopeKey(head.scopeKey) ||
          edited.path !== head.path ||
          !this.allowed(edited)
        )
          throw new MemoryAccessError();
      } catch {
        // Preserve suspect bytes only in app-private quarantine, outside any synced folder.
        // Detection reduces risk and cannot recognise arbitrary secrets.
        await this.options.quarantine.write(`${contentHash(raw)}.txt`, raw, false);
        await this.options.files.remove(notePath, raw);
        await this.options.files.write(notePath, expected, true, null);
        throw new Error(
          "This note was quarantined. Remove credentials or invalid frontmatter before importing it.",
        );
      }
      if (edited.revision !== head.revision || head.deletedAt) {
        await this.options.files.write(`${notePath.slice(0, -3)}.conflict-${randomUUID()}.md`, raw);
        await this.options.files.write(notePath, expected, true, raw);
        throw new MemoryConflictError();
      }
      const revision: DocumentRevision = {
        ...head,
        content: edited.content,
        references: edited.references,
        revision: head.revision + 1,
        createdAt: this.now().toISOString(),
        author: { kind: "user", userId: this.options.ownerUserId },
        model: null,
        runId: null,
        threadId: null,
      };
      doc.revisions.push(revision);
      if (doc.delivery.provider) doc.delivery.status = "pending";
    }
  }
  async transaction<T>(
    access: MemoryAccess,
    action: (docs: JournalDocument[]) => Promise<T>,
  ): Promise<T> {
    if (access.spaceId !== this.options.spaceId) throw new MemoryAccessError();
    return this.options.exclusive(async () => {
      const state = await this.load();
      const before = JSON.stringify(state);
      const observed = new Map<string, string | null>();
      await this.reconcile(state, access, observed);
      // External edits must survive a subsequent optimistic conflict in the caller's edit.
      if (JSON.stringify(state) !== before) await this.persist(state, observed);
      const docs = structuredClone(state.documents);
      const result = await action(docs);
      for (const doc of docs)
        if (!doc.revisions.every((r) => this.allowed(r))) throw new MemoryAccessError();
      state.documents = docs;
      if (docs.length || (await this.options.files.read(JOURNAL)))
        await this.persist(state, observed);
      return result;
    });
  }
}
export class ObsidianDocumentStore extends JournalDocumentStore {
  constructor(options: ObsidianStoreOptions) {
    super(new ObsidianJournal(options), "obsidian", options.clock);
  }
}

/** A selected shared folder is never the destination for private bot/other-user memories. */
export class VaultWithPrivateDocuments implements MemoryDocumentStore {
  constructor(
    private readonly vault: MemoryDocumentStore,
    private readonly privateStore: MemoryDocumentStore,
    private readonly ownerUserId: string | null,
  ) {}
  describe() {
    return this.vault.describe();
  }
  startSession(access: MemoryAccess) {
    return this.vault.startSession?.(access) ?? Promise.resolve();
  }
  push(access: MemoryAccess) {
    return this.vault.push?.(access) ?? Promise.resolve();
  }
  syncState(access: MemoryAccess) {
    return this.vault.syncState?.(access) ?? Promise.resolve(null);
  }
  private selected(scope: DocumentRevision["scopeKey"]) {
    return scope.kind === "space-shared" ||
      (scope.kind === "user" && scope.userId === this.ownerUserId)
      ? this.vault
      : this.privateStore;
  }
  private async forId(id: string, access: MemoryAccess) {
    const doc = await this.read(id, access);
    if (!doc) throw new MemoryAccessError();
    return this.selected(doc.scopeKey);
  }
  async list(input: Parameters<MemoryDocumentStore["list"]>[0], access: MemoryAccess) {
    const limit = input.limit ?? 50;
    const collect = async (store: MemoryDocumentStore) => {
      const items: MemoryDocumentHead[] = [];
      let cursor = input.cursor;
      do {
        const page = await store.list({ ...input, cursor, limit: 100 }, access);
        items.push(...page.items.filter((doc) => this.selected(doc.scopeKey) === store));
        cursor = page.nextCursor ?? undefined;
      } while (cursor && items.length <= limit);
      return items;
    };
    const [vault, own] = await Promise.all([collect(this.vault), collect(this.privateStore)]);
    const all = [...vault, ...own].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const items = all.slice(0, limit);
    return {
      items,
      nextCursor: all.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  }
  async read(id: string, access: MemoryAccess) {
    const vault = await this.vault.read(id, access);
    if (vault) return vault;
    const own = await this.privateStore.read(id, access);
    return own && this.selected(own.scopeKey) === this.privateStore ? own : null;
  }
  commit(...args: Parameters<MemoryDocumentStore["commit"]>) {
    return this.selected(args[0].scopeKey).commit(...args);
  }
  async delete(...args: Parameters<MemoryDocumentStore["delete"]>) {
    return (await this.forId(args[0], args[3])).delete(...args);
  }
  async restore(...args: Parameters<MemoryDocumentStore["restore"]>) {
    return (await this.forId(args[0], args[4])).restore(...args);
  }
  async history(...args: Parameters<MemoryDocumentStore["history"]>) {
    return (await this.forId(args[0], args[2])).history(...args);
  }
  async exportBundle(access: MemoryAccess): Promise<MemoryBundle> {
    const [vault, own] = await Promise.all([
      this.vault.exportBundle(access),
      this.privateStore.exportBundle(access),
    ]);
    return {
      version: 1,
      documents: [
        ...vault.documents,
        ...own.documents.filter(
          (d) => this.selected(d.revisions.at(-1)!.scopeKey) === this.privateStore,
        ),
      ],
    };
  }
  async importBundle(
    bundle: MemoryBundle,
    delivery: Parameters<MemoryDocumentStore["importBundle"]>[1],
    access: MemoryAccess,
  ) {
    const result = previewImport(bundle, await this.exportBundle(access), access);
    requireImportReady(result.preview, result.preview.hash);
    bundle = result.bundle;
    for (const store of [this.vault, this.privateStore]) {
      await store.importBundle(
        {
          version: 1,
          documents: bundle.documents.filter(
            (d) => this.selected(d.revisions.at(-1)!.scopeKey) === store,
          ),
        },
        delivery,
        access,
      );
    }
  }
  async setDelivery(...args: Parameters<MemoryDocumentStore["setDelivery"]>) {
    return (await this.forId(args[0], args[3])).setDelivery(...args);
  }
}
