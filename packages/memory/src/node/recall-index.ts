import type { MemoryDocumentHead } from "@ardurbot/adapter-kit";
import { getLogger } from "@ardurbot/logging";

/** The scopes recall can answer for; "shared" is the space-shared scope visible to every member. */
export type RecallIndexScope = "bot" | "user" | "shared";

export interface RecallIndexDocument {
  id: string;
  path: string;
  content: string;
  revision: number;
  scope: RecallIndexScope;
  /** Bot id for bot rows, user id for user rows, empty for shared rows. */
  owner: string;
}

export interface RecallIndexHit {
  id: string;
  path: string;
  revision: number;
  scope: RecallIndexScope;
  owner: string;
  /** BM25 score normalized so higher ranks better. */
  score: number;
}

export interface RecallIndexQuery {
  words: readonly string[];
  botId: string;
  userId: string;
  limit: number;
}

/** The slice of `node:sqlite` this module relies on, so tests can inject a loader. */
export interface RecallIndexDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: Array<string | number>): unknown;
    all(...params: Array<string | number>): Array<Record<string, unknown>>;
  };
  close(): void;
}
export type RecallIndexDatabaseConstructor = new (path: string) => RecallIndexDatabase;
export type RecallIndexLoader = () => Promise<RecallIndexDatabaseConstructor | null>;

export interface MemoryRecallIndexOptions {
  loader?: RecallIndexLoader;
  onUnavailable?: (reason: string) => void;
}

const TABLE_SCHEMA = `CREATE VIRTUAL TABLE documents USING fts5(
  path,
  content,
  id UNINDEXED,
  revision UNINDEXED,
  scope UNINDEXED,
  owner UNINDEXED,
  tokenize = 'porter unicode61'
)`;
const RECALL_QUERY = `SELECT id, revision, scope, owner, path, bm25(documents, 3.0, 1.0) AS rank
FROM documents
WHERE documents MATCH ?
  AND ((scope = 'bot' AND owner = ?) OR (scope = 'user' AND owner = ?) OR scope = 'shared')
ORDER BY rank ASC, path ASC
LIMIT ?`;

/** Procedures and typed settings are never recall knowledge. */
const EXCLUDED_PATH = /^(?:skills|preferences)\//u;

async function defaultLoader(): Promise<RecallIndexDatabaseConstructor | null> {
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: RecallIndexDatabaseConstructor;
    };
    const probe = new DatabaseSync(":memory:");
    probe.exec(TABLE_SCHEMA);
    probe.close();
    return DatabaseSync;
  } catch {
    return null;
  }
}

/** Map a committed head to an index row; null means the document is never recall knowledge. */
function indexableDocument(document: MemoryDocumentHead): RecallIndexDocument | null {
  const scope = document.scopeKey;
  if (scope.kind === "group" || EXCLUDED_PATH.test(document.path)) return null;
  return {
    id: document.id,
    path: document.path,
    content: document.content,
    revision: document.revision,
    scope: scope.kind === "space-shared" ? "shared" : scope.kind,
    owner: scope.kind === "bot" ? scope.botId : scope.kind === "user" ? scope.userId : "",
  };
}

interface SpaceEntry {
  db: RecallIndexDatabase | null;
  failed: boolean;
  opening: Promise<RecallIndexDatabase | null> | null;
  slices: Set<string>;
  pending: Array<{ id: string; document: RecallIndexDocument | null }>;
}

/**
 * One in-memory FTS5 index per space, built lazily from the same documents recall reads and
 * kept current by the memory write path. The store stays authoritative: recall re-verifies
 * every candidate before use, so a stale row is dropped, never served.
 */
export class MemoryRecallIndex {
  private readonly loader: RecallIndexLoader;
  private readonly onUnavailable: (reason: string) => void;
  private readonly spaces = new Map<string, SpaceEntry>();
  private loaded: Promise<RecallIndexDatabaseConstructor | null> | null = null;
  private disabled = false;
  private notified = false;

  constructor(options: MemoryRecallIndexOptions = {}) {
    this.loader = options.loader ?? defaultLoader;
    this.onUnavailable =
      options.onUnavailable ??
      ((reason) =>
        getLogger().warn("local memory recall index unavailable; using the document scan", {
          reason,
        }));
  }

  hasSlice(spaceId: string, sliceKey: string): boolean {
    return this.spaces.get(spaceId)?.slices.has(sliceKey) ?? false;
  }

  /** Index one slice of a space (one bot or one user read). False means the caller must scan. */
  async indexSlice(
    spaceId: string,
    sliceKey: string,
    documents: readonly RecallIndexDocument[],
  ): Promise<boolean> {
    if (this.disabled) return false;
    let entry = this.spaces.get(spaceId);
    if (!entry) {
      entry = { db: null, failed: false, opening: null, slices: new Set(), pending: [] };
      this.spaces.set(spaceId, entry);
    }
    if (entry.slices.has(sliceKey)) return true;
    const db = await this.database(spaceId, entry);
    if (!db) return false;
    try {
      db.exec("BEGIN");
      try {
        for (const document of documents)
          if (document.id && !EXCLUDED_PATH.test(document.path))
            this.replace(db, { id: document.id, document });
        entry.slices.add(sliceKey);
        // Writes that committed before or during the build replay after the bulk load, so
        // the index and the store never diverge across the first build.
        for (const write of entry.pending.splice(0)) this.replace(db, write);
      } finally {
        db.exec("COMMIT");
      }
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The rollback only matters when the transaction is still open.
      }
      entry.failed = true;
      this.spaces.delete(spaceId);
      this.noteUnavailable(error instanceof Error ? error.message : "index build failed");
      return false;
    }
    return true;
  }

  /** Write-path sink: upsert or remove one committed document. Never throws. */
  applyWrite(spaceId: string, document: MemoryDocumentHead): void {
    this.write(spaceId, document.id, document.deletedAt ? null : indexableDocument(document));
  }

  /** Re-verification feeds fresh rows back, so a stale row heals without a rebuild. */
  upsert(spaceId: string, document: RecallIndexDocument): void {
    this.write(spaceId, document.id, EXCLUDED_PATH.test(document.path) ? null : document);
  }

  remove(spaceId: string, id: string): void {
    this.write(spaceId, id, null);
  }

  /** BM25-ranked candidates, or null when the index is unavailable and the caller must scan. */
  async query(spaceId: string, request: RecallIndexQuery): Promise<RecallIndexHit[] | null> {
    if (this.disabled) return null;
    const entry = this.spaces.get(spaceId);
    if (!entry || entry.failed) return null;
    const db = await this.database(spaceId, entry);
    if (!db) return null;
    if (!request.words.length) return [];
    const match = request.words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR ");
    try {
      const rows = db
        .prepare(RECALL_QUERY)
        .all(match, request.botId, request.userId, request.limit);
      return rows.map((row) => ({
        id: String(row.id),
        path: String(row.path),
        revision: Number(row.revision),
        scope: row.scope as RecallIndexScope,
        owner: String(row.owner),
        score: -Number(row.rank),
      }));
    } catch {
      return null;
    }
  }

  private write(spaceId: string, id: string, document: RecallIndexDocument | null): void {
    if (this.disabled) return;
    let entry = this.spaces.get(spaceId);
    if (!entry) {
      // A write can commit before the space's first slice build creates its entry, while the
      // build's store read is still in flight. Open the entry so the write reaches the
      // replay buffer instead of being dropped; the build replays it over its snapshot.
      entry = { db: null, failed: false, opening: null, slices: new Set(), pending: [] };
      this.spaces.set(spaceId, entry);
    }
    if (entry.failed) return;
    const row = { id, document };
    if (!entry.db) {
      // The lazy build's snapshot may predate this write, so anything arriving before the
      // database is ready must replay after the bulk load, not just during `opening`.
      entry.pending.push(row);
      return;
    }
    try {
      this.replace(entry.db, row);
    } catch {
      // The store stays authoritative; a failed upsert is dropped at re-verification.
    }
  }

  private replace(
    db: RecallIndexDatabase,
    row: { id: string; document: RecallIndexDocument | null },
  ): void {
    db.prepare("DELETE FROM documents WHERE id = ?").run(row.id);
    if (row.document)
      db.prepare(
        "INSERT INTO documents(path, content, id, revision, scope, owner) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(
        row.document.path,
        row.document.content,
        row.document.id,
        row.document.revision,
        row.document.scope,
        row.document.owner,
      );
  }

  private async database(spaceId: string, entry: SpaceEntry): Promise<RecallIndexDatabase | null> {
    if (entry.db) return entry.db;
    if (entry.failed) return null;
    entry.opening ??= (async () => {
      const databaseConstructor = await this.load();
      if (!databaseConstructor) return null;
      try {
        const db = new databaseConstructor(":memory:");
        db.exec(TABLE_SCHEMA);
        return db;
      } catch {
        return null;
      }
    })();
    const db = await entry.opening;
    if (db) entry.db = db;
    else {
      entry.failed = true;
      entry.opening = null;
      this.noteUnavailable(`node:sqlite with FTS5 is not available for space ${spaceId}`);
    }
    return db;
  }

  private load(): Promise<RecallIndexDatabaseConstructor | null> {
    this.loaded ??= this.loader().then((databaseConstructor) => {
      if (databaseConstructor) return databaseConstructor;
      this.disabled = true;
      this.noteUnavailable("node:sqlite with FTS5 is not available");
      return null;
    });
    return this.loaded;
  }

  private noteUnavailable(reason: string): void {
    if (this.notified) return;
    this.notified = true;
    this.onUnavailable(reason);
  }
}

/** Process-wide index shared by the memory write path and local recall. */
export const sharedMemoryRecallIndex = new MemoryRecallIndex();
