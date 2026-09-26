import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";

/**
 * Applies `prisma/migrations` the way `prisma migrate deploy` does, without the
 * Prisma CLI. Prisma's migration history is the `_prisma_migrations` table plus
 * the `migration.sql` files. A migration counts as applied only when `finished_at`
 * is set. Changing a file after that is the edited-migration case Prisma reports
 * as modified and will not ignore. A row with `finished_at` still null is a failed
 * migration (Prisma error P3009) and blocks later ones. This runner never leaves
 * one behind on a failure it sees: the history row commits with the migration's
 * SQL, and a failed `CONCURRENTLY` migration is marked `rolled_back_at`, which is
 * what `prisma migrate resolve --rolled-back` records, so the next run applies it.
 *
 * https://www.prisma.io/docs/orm/prisma-migrate/understanding-prisma-migrate/migration-histories
 * https://www.prisma.io/docs/orm/reference/error-reference#p3009
 *
 * The checksum is the SHA-256 hex digest of the `migration.sql` bytes. That is the
 * schema-engine checksum over the script, so a later `prisma migrate status` on the
 * same database reports nothing pending when the bytes still match.
 *
 * Like `prisma migrate deploy`, each `migration.sql` is sent as one query, so a file
 * Prisma can apply applies here unchanged. Every file runs inside a transaction with
 * its history row, except one that builds or drops an index `CONCURRENTLY`: that
 * cannot run in a transaction block, and Prisma keeps it as the only statement in
 * its file. Such a file can be interrupted halfway (a cancel, the server stopping, or
 * the app quitting), which leaves an INVALID index, or a finished index whose history row
 * was never marked. Before it is applied again, an INVALID leftover is dropped, and an
 * index already in place is recorded as finished instead of built again, so a retry
 * always works.
 */
export class MigrationHistoryError extends Error {
  /**
   * `newer`: the database has a migration this build does not ship. `modified`: a shipped
   * file changed after it was applied. `unfinished`: a transactional migration another
   * tool started never finished. `apply`: the migration's own SQL failed. `unusable`: the
   * connection string names a database or role this runner will not quote.
   */
  readonly reason: "newer" | "modified" | "unfinished" | "apply" | "unusable";

  constructor(message: string, reason: MigrationHistoryError["reason"]) {
    super(message);
    this.name = "MigrationHistoryError";
    this.reason = reason;
  }
}

/** The migration's SQL failed. `databaseError` is the database's own message. */
export class MigrationApplyError extends MigrationHistoryError {
  readonly migrationName: string;
  readonly databaseError: string;

  constructor(migrationName: string, databaseError: string) {
    super(`Migration "${migrationName}" failed to apply. ${databaseError}`, "apply");
    this.name = "MigrationApplyError";
    this.migrationName = migrationName;
    this.databaseError = databaseError;
  }
}

export interface MigrationSqlClient {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
}

export interface SqlMigration {
  name: string;
  sql: string;
  checksum: string;
}

interface RecordedMigration {
  id: string;
  checksum: string;
  migrationName: string;
  finishedAt: unknown;
  rolledBackAt: unknown;
  logs: unknown;
}

const MIGRATION_LOCK = 881122334455;
const MIGRATIONS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" VARCHAR(36) NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY ("id")
)`;

export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

export async function listSqlMigrations(migrationsDir: string): Promise<SqlMigration[]> {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const migrations: SqlMigration[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(migrationsDir, name, "migration.sql"));
    const text = sql.toString("utf8");
    migrations.push({ name, sql: text, checksum: migrationChecksum(text) });
  }
  return migrations;
}

/**
 * `applied` lists the migrations whose SQL ran. One an earlier attempt already built is
 * recorded as finished without being listed.
 */
export async function applySqlMigrations(input: {
  client: MigrationSqlClient;
  migrationsDir: string;
  /** Checked before each migration and right before its SQL is sent. */
  signal?: AbortSignal;
}): Promise<{ applied: string[] }> {
  input.signal?.throwIfAborted();
  await input.client.query(MIGRATIONS_TABLE_SQL);
  await input.client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK]);
  try {
    const migrations = await listSqlMigrations(input.migrationsDir);
    const recorded = await readRecorded(input.client);
    await settleInterrupted(input.client, migrations, recorded);
    assertHistory(migrations, recorded);
    const applied: string[] = [];
    for (const migration of migrations) {
      if (finishedRow(recorded, migration.name)) continue;
      input.signal?.throwIfAborted();
      // An earlier attempt built it but was rolled back before its row was marked finished.
      if (
        triedConcurrently(recorded, migration) &&
        (await indexesInPlace(input.client, migration.sql))
      ) {
        await recordFinished(input.client, await recordStarted(input.client, migration));
        continue;
      }
      await applyOne(input.client, migration, input.signal);
      applied.push(migration.name);
    }
    return { applied };
  } finally {
    await input.client
      .query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK])
      .catch(() => undefined);
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * initdb creates only the `postgres` database and its superuser. The application database
 * belongs to its own login role, named by `databaseUrl`, which migrations and the services
 * use; the superuser in `adminUrl` is kept for maintenance. The role's password is set from
 * `databaseUrl` on every call, so a regenerated password takes effect. When both URLs name
 * the same user, only the database is created.
 */
export async function ensureApplicationDatabase(input: {
  adminUrl: string;
  databaseUrl: string;
  signal?: AbortSignal;
}): Promise<void> {
  const target = new URL(input.databaseUrl);
  const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
  const owner = decodeURIComponent(target.username);
  if (!IDENTIFIER.test(database) || !IDENTIFIER.test(owner)) {
    throw new MigrationHistoryError("The application database name is not usable.", "unusable");
  }
  const admin = new URL(input.adminUrl);
  const separate = decodeURIComponent(admin.username) !== owner;
  admin.pathname = "/postgres";
  await withClient(admin.toString(), input.signal, async (client) => {
    if (separate) {
      const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [owner]);
      const password = client.escapeLiteral(decodeURIComponent(target.password));
      await client.query(
        `${role.rowCount ? "ALTER" : "CREATE"} ROLE "${owner}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${password}`,
      );
    }
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if (existing.rowCount) return;
    await client.query(`CREATE DATABASE "${database}"${separate ? ` OWNER "${owner}"` : ""}`);
  });
}

export async function applySqlMigrationsToDatabase(input: {
  connectionString: string;
  migrationsDir: string;
  signal?: AbortSignal;
}): Promise<{ applied: string[] }> {
  return withClient(input.connectionString, input.signal, (client) =>
    applySqlMigrations({
      client: {
        query: (text, values) => client.query(text, values as unknown[]),
      },
      migrationsDir: input.migrationsDir,
      signal: input.signal,
    }),
  );
}

/**
 * A connection whose `error` event never becomes an uncaught exception: a server that
 * stops mid-query rejects the query instead. An abort cancels the running statement from
 * a second connection, so the caller settles instead of waiting for it to finish.
 */
async function withClient<T>(
  connectionString: string,
  signal: AbortSignal | undefined,
  use: (client: Client) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const client = new Client({ connectionString });
  client.on("error", () => undefined);
  let pid: number | null = null;
  const cancel = () => {
    if (pid !== null) void cancelBackend(connectionString, pid);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await client.connect();
    pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    signal?.throwIfAborted();
    return await use(client);
  } finally {
    signal?.removeEventListener("abort", cancel);
    await client.end().catch(() => undefined);
  }
}

async function cancelBackend(connectionString: string, pid: number): Promise<void> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 3_000 });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.query("SELECT pg_cancel_backend($1)", [pid]);
  } catch {
    // The server is gone, which ends the statement too.
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * With the advisory lock held no other run is active, so a CONCURRENTLY row with neither
 * `finished_at` nor `rolled_back_at` was cut off: the server stopped, or the app quit,
 * before the row was marked. When what the file builds or drops is already in place, only
 * the record is missing, and the row is marked finished. Otherwise it is marked rolled
 * back, as `prisma migrate resolve --rolled-back` would, and applied again. A
 * transactional migration cannot leave such a row: its row commits with its SQL.
 */
async function settleInterrupted(
  client: MigrationSqlClient,
  migrations: SqlMigration[],
  recorded: RecordedMigration[],
): Promise<void> {
  const files = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const row of recorded) {
    if (row.finishedAt != null || row.rolledBackAt != null) continue;
    const file = files.get(row.migrationName);
    if (!file || !buildsIndexConcurrently(file.sql)) continue;
    if (row.checksum === file.checksum && (await indexesInPlace(client, file.sql))) {
      await recordFinished(client, row.id);
      row.finishedAt = new Date();
      continue;
    }
    await client.query(
      `UPDATE "_prisma_migrations" SET "rolled_back_at" = CURRENT_TIMESTAMP WHERE "id" = $1`,
      [row.id],
    );
    row.rolledBackAt = new Date();
  }
}

function assertHistory(migrations: SqlMigration[], recorded: RecordedMigration[]): void {
  const files = new Map(migrations.map((migration) => [migration.name, migration]));
  for (const row of recorded) {
    if (row.rolledBackAt != null) continue;
    const file = files.get(row.migrationName);
    if (!file) {
      throw new MigrationHistoryError(
        `The migration "${row.migrationName}" is applied in the database but missing from the migrations directory.`,
        "newer",
      );
    }
    if (row.finishedAt == null) {
      throw new MigrationHistoryError(
        `Migration "${row.migrationName}" failed and must be resolved before new migrations run.`,
        "unfinished",
      );
    }
    if (row.checksum !== file.checksum) {
      throw new MigrationHistoryError(
        `The migration "${row.migrationName}" was modified after it was applied.`,
        "modified",
      );
    }
  }
}

function finishedRow(recorded: RecordedMigration[], name: string): boolean {
  return recorded.some(
    (row) => row.migrationName === name && row.finishedAt != null && row.rolledBackAt == null,
  );
}

/** A CONCURRENTLY migration this database has a history row for, so an earlier run began it. */
function triedConcurrently(recorded: RecordedMigration[], migration: SqlMigration): boolean {
  return (
    buildsIndexConcurrently(migration.sql) &&
    recorded.some((row) => row.migrationName === migration.name)
  );
}

async function recordStarted(client: MigrationSqlClient, migration: SqlMigration) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "applied_steps_count")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, 0)`,
    [id, migration.checksum, migration.name],
  );
  return id;
}

async function recordFinished(client: MigrationSqlClient, id: string): Promise<void> {
  await client.query(
    `UPDATE "_prisma_migrations" SET "finished_at" = CURRENT_TIMESTAMP, "applied_steps_count" = 1, "logs" = NULL WHERE "id" = $1`,
    [id],
  );
}

async function applyOne(
  client: MigrationSqlClient,
  migration: SqlMigration,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (buildsIndexConcurrently(migration.sql)) {
    await dropInvalidIndexes(client, migration.sql);
    const id = await recordStarted(client, migration);
    try {
      signal?.throwIfAborted();
      await client.query(migration.sql);
      // A row that cannot be marked finished is rolled back too, never left open.
      await recordFinished(client, id);
    } catch (error) {
      const message = errorMessage(error);
      await client
        .query(
          `UPDATE "_prisma_migrations" SET "rolled_back_at" = CURRENT_TIMESTAMP, "logs" = $2 WHERE "id" = $1`,
          [id, message],
        )
        .catch(() => undefined);
      throw new MigrationApplyError(migration.name, message);
    }
    return;
  }
  await client.query("BEGIN");
  try {
    const id = await recordStarted(client, migration);
    signal?.throwIfAborted();
    await client.query(migration.sql);
    await recordFinished(client, id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw new MigrationApplyError(migration.name, errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readRecorded(client: MigrationSqlClient): Promise<RecordedMigration[]> {
  const result = await client.query(
    `SELECT "id", "checksum", "migration_name", "finished_at", "rolled_back_at", "logs" FROM "_prisma_migrations"`,
  );
  return result.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: String(record.id),
      checksum: String(record.checksum),
      migrationName: String(record.migration_name),
      finishedAt: record.finished_at,
      rolledBackAt: record.rolled_back_at,
      logs: record.logs,
    };
  });
}

/** Comments are ignored: a file may explain why it does not build an index concurrently. */
function withoutComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

function buildsIndexConcurrently(sql: string): boolean {
  return /\bINDEX\s+CONCURRENTLY\b/i.test(withoutComments(sql));
}

const IDENTIFIER_TOKEN = '"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*';
const CREATES = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER_TOKEN})`,
  "gi",
);
const DROPS = new RegExp(
  String.raw`\bDROP\s+INDEX\s+CONCURRENTLY\s+(?:IF\s+EXISTS\s+)?(${IDENTIFIER_TOKEN})(?:\s*\.\s*(${IDENTIFIER_TOKEN}))?`,
  "gi",
);

interface IndexName {
  /** Null for the current schema. */
  schema: string | null;
  name: string;
}

/**
 * The indexes a CONCURRENTLY file builds and drops. An unnamed build (`... CONCURRENTLY ON t`)
 * is null: it gets a fresh name on every attempt.
 */
function indexTargets(sql: string): { created: (IndexName | null)[]; dropped: IndexName[] } {
  const text = withoutComments(sql);
  return {
    created: [...text.matchAll(CREATES)].map((match) =>
      /^on$/i.test(match[1]!) ? null : { schema: null, name: identifier(match[1]!) },
    ),
    dropped: [...text.matchAll(DROPS)].map((match) =>
      match[2]
        ? { schema: identifier(match[1]!), name: identifier(match[2]) }
        : { schema: null, name: identifier(match[1]!) },
    ),
  };
}

function identifier(token: string): string {
  return token.startsWith('"') ? token.slice(1, -1).replaceAll('""', '"') : token.toLowerCase();
}

/** The index as a quoted `schema.name`, and whether it is valid; null when there is none. */
async function findIndex(
  client: MigrationSqlClient,
  target: IndexName,
): Promise<{ index: string; valid: boolean } | null> {
  const result = await client.query(
    `SELECT format('%I.%I', n.nspname, c.relname) AS "index", i.indisvalid AS "valid"
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_index i ON i.indexrelid = c.oid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = $1 AND n.nspname = COALESCE($2, current_schema())`,
    [target.name, target.schema],
  );
  return (result.rows[0] as { index: string; valid: boolean } | undefined) ?? null;
}

/**
 * Whether the file's work is already done: every index it builds exists and is valid, and
 * every index it drops is gone. A file with an unnamed build cannot be checked, so it is not.
 */
async function indexesInPlace(client: MigrationSqlClient, sql: string): Promise<boolean> {
  const { created, dropped } = indexTargets(sql);
  if (created.length + dropped.length === 0 || created.includes(null)) return false;
  for (const target of created) {
    if (!(await findIndex(client, target!))?.valid) return false;
  }
  for (const target of dropped) {
    if (await findIndex(client, target)) return false;
  }
  return true;
}

/**
 * An interrupted `CREATE INDEX CONCURRENTLY` leaves an INVALID index behind. A plain retry
 * then fails with "already exists", and one with IF NOT EXISTS succeeds over the broken
 * index. An INVALID index of a name this file creates is dropped first, as
 * `20260828090002a_group_organization_repair_invalid_idx` does.
 */
async function dropInvalidIndexes(client: MigrationSqlClient, sql: string): Promise<void> {
  for (const target of indexTargets(sql).created) {
    const found = target && (await findIndex(client, target));
    if (found && !found.valid) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${found.index}`);
    }
  }
}
