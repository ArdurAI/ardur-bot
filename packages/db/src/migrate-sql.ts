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
 * `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` cannot run inside a
 * transaction block. Prisma leaves those as the only statement in a file so the
 * simple-query protocol does not wrap them. This runner does the same: those
 * statements run on their own, and every other file runs in one transaction.
 */
export class MigrationHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationHistoryError";
  }
}

/** The migration's SQL failed. `databaseError` is the database's own message. */
export class MigrationApplyError extends MigrationHistoryError {
  readonly migrationName: string;
  readonly databaseError: string;

  constructor(migrationName: string, databaseError: string) {
    super(`Migration "${migrationName}" failed to apply. ${databaseError}`);
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

export async function applySqlMigrations(input: {
  client: MigrationSqlClient;
  migrationsDir: string;
}): Promise<{ applied: string[] }> {
  await input.client.query(MIGRATIONS_TABLE_SQL);
  await input.client.query("SELECT pg_advisory_lock($1::bigint)", [MIGRATION_LOCK]);
  try {
    const migrations = await listSqlMigrations(input.migrationsDir);
    const recorded = await readRecorded(input.client);
    assertHistory(migrations, recorded);
    const applied: string[] = [];
    for (const migration of migrations) {
      if (finishedRow(recorded, migration.name)) continue;
      await applyOne(input.client, migration);
      applied.push(migration.name);
      recorded.push({
        id: "applied",
        checksum: migration.checksum,
        migrationName: migration.name,
        finishedAt: new Date(),
        rolledBackAt: null,
        logs: null,
      });
    }
    return { applied };
  } finally {
    await input.client
      .query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK])
      .catch(() => undefined);
  }
}

/** initdb creates the `postgres` database, not the application database. */
export async function ensureApplicationDatabase(connectionString: string): Promise<void> {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new MigrationHistoryError("The application database name is not usable.");
  }
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  try {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
    if ((found.rowCount ?? 0) === 0) await client.query(`CREATE DATABASE "${database}"`);
  } finally {
    await client.end();
  }
}

export async function applySqlMigrationsToDatabase(input: {
  connectionString: string;
  migrationsDir: string;
}): Promise<{ applied: string[] }> {
  const client = new Client({ connectionString: input.connectionString });
  await client.connect();
  try {
    return await applySqlMigrations({
      client: {
        query: (text, values) => client.query(text, values as unknown[]),
      },
      migrationsDir: input.migrationsDir,
    });
  } finally {
    await client.end();
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
      );
    }
    if (row.finishedAt == null) {
      throw new MigrationHistoryError(
        `Migration "${row.migrationName}" failed and must be resolved before new migrations run.`,
      );
    }
    if (row.checksum !== file.checksum) {
      throw new MigrationHistoryError(
        `The migration "${row.migrationName}" was modified after it was applied.`,
      );
    }
  }
}

function finishedRow(recorded: RecordedMigration[], name: string): boolean {
  return recorded.some(
    (row) => row.migrationName === name && row.finishedAt != null && row.rolledBackAt == null,
  );
}

async function applyOne(client: MigrationSqlClient, migration: SqlMigration): Promise<void> {
  const id = randomUUID();
  const statements = splitSqlStatements(migration.sql);
  const record = () =>
    client.query(
      `INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "applied_steps_count")
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, 0)`,
      [id, migration.checksum, migration.name],
    );
  const finish = () =>
    client.query(
      `UPDATE "_prisma_migrations" SET "finished_at" = CURRENT_TIMESTAMP, "applied_steps_count" = $2, "logs" = NULL WHERE "id" = $1`,
      [id, Math.max(statements.length, 1)],
    );
  if (statements.some((statement) => isConcurrentIndex(statement))) {
    await record();
    try {
      for (const statement of statements) await client.query(statement);
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
    await finish();
    return;
  }
  await client.query("BEGIN");
  try {
    await record();
    for (const statement of statements) await client.query(statement);
    await finish();
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

function isConcurrentIndex(statement: string): boolean {
  return /\b(?:CREATE|DROP)\s+INDEX\s+CONCURRENTLY\b/i.test(stripSqlComments(statement));
}

export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;
  let dollar: string | null = null;
  while (index < script.length) {
    if (dollar !== null) {
      if (script.startsWith(dollar, index)) {
        current += dollar;
        index += dollar.length;
        dollar = null;
        continue;
      }
      current += script[index];
      index += 1;
      continue;
    }
    if (script.startsWith("--", index)) {
      const end = script.indexOf("\n", index);
      const slice = end === -1 ? script.slice(index) : script.slice(index, end + 1);
      current += slice;
      index += slice.length;
      continue;
    }
    if (script.startsWith("/*", index)) {
      const end = script.indexOf("*/", index + 2);
      const slice = end === -1 ? script.slice(index) : script.slice(index, end + 2);
      current += slice;
      index += slice.length;
      continue;
    }
    const quote = script[index];
    if (quote === "'" || quote === '"') {
      current += quote;
      index += 1;
      while (index < script.length) {
        const char = script[index] ?? "";
        current += char;
        if (quote === "'" && char === "'" && script[index + 1] === "'") {
          current += script[index + 1];
          index += 2;
          continue;
        }
        index += 1;
        if (char === quote) break;
      }
      continue;
    }
    if (quote === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(script.slice(index));
      if (tag?.[0]) {
        dollar = tag[0];
        current += dollar;
        index += dollar.length;
        continue;
      }
    }
    if (quote === ";") {
      pushStatement(statements, current);
      current = "";
      index += 1;
      continue;
    }
    current += quote ?? "";
    index += 1;
  }
  pushStatement(statements, current);
  return statements;
}

function pushStatement(statements: string[], raw: string): void {
  const statement = raw.trim();
  if (statement !== "" && stripSqlComments(statement).trim() !== "") statements.push(statement);
}

function stripSqlComments(script: string): string {
  return script.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

export const migrationsTableSql = MIGRATIONS_TABLE_SQL;
