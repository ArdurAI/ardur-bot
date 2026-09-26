import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applySqlMigrations,
  listSqlMigrations,
  MigrationApplyError,
  MigrationHistoryError,
  migrationChecksum,
} from "./migrate-sql.js";

const migrationsDir = fileURLToPath(new URL("../prisma/migrations/", import.meta.url));

interface RecordedMigration {
  id: string;
  checksum: string;
  migrationName: string;
  finishedAt: string | null;
  rolledBackAt: string | null;
  logs: string | null;
  appliedStepsCount: number;
}

class MemoryMigrations {
  readonly rows: RecordedMigration[] = [];
  readonly scripts: string[] = [];
  /** A statement containing this text fails the way Postgres would. */
  failOn: string | null = null;
  /** Indexes by `schema.name`, and whether each is valid; false is an interrupted build's leftover. */
  readonly indexes = new Map<string, boolean>();
  /** Marking a history row finished fails, as a cancel that reaches that UPDATE would. */
  failFinish = false;
  private beforeTransaction: RecordedMigration[] | null = null;
  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: unknown[] }> {
    if (text === "BEGIN") this.beforeTransaction = this.rows.map((row) => ({ ...row }));
    if (text === "COMMIT") this.beforeTransaction = null;
    if (text === "ROLLBACK" && this.beforeTransaction) {
      this.rows.splice(0, this.rows.length, ...this.beforeTransaction);
      this.beforeTransaction = null;
    }
    if (this.failOn !== null && text.includes(this.failOn) && !text.includes("_prisma_migrations"))
      throw new Error('relation "widgets" does not exist');
    if (text.includes("indisvalid")) {
      const [name, schema] = values;
      const index = `${schema ?? "public"}.${String(name)}`;
      const valid = this.indexes.get(index);
      return { rows: valid === undefined ? [] : [{ index, valid }] };
    }
    if (text.startsWith("DROP INDEX CONCURRENTLY IF EXISTS ")) {
      this.indexes.delete(text.slice("DROP INDEX CONCURRENTLY IF EXISTS ".length));
    }
    if (text.includes("INSERT INTO") && text.includes("_prisma_migrations")) {
      const [id, checksum, migrationName] = values;
      this.rows.push({
        id: String(id),
        checksum: String(checksum),
        migrationName: String(migrationName),
        finishedAt: null,
        rolledBackAt: null,
        logs: null,
        appliedStepsCount: 0,
      });
      return { rows: [] };
    }
    if (text.includes("finished_at") && text.includes("UPDATE")) {
      if (this.failFinish) throw new Error("canceling statement due to user request");
      const [id] = values;
      const row = this.rows.find((item) => item.id === id);
      if (row) {
        row.finishedAt = "finished";
        row.appliedStepsCount = Number(/"applied_steps_count" = (\d+)/.exec(text)?.[1]);
        row.logs = null;
      }
      return { rows: [] };
    }
    if (text.includes("rolled_back_at") && text.includes("UPDATE")) {
      const [id, logs] = values;
      const row = this.rows.find((item) => item.id === id);
      if (row) {
        row.rolledBackAt = "rolled back";
        row.logs = String(logs);
      }
      return { rows: [] };
    }
    if (text.includes("logs") && text.includes("UPDATE")) {
      const [id, logs] = values;
      const row = this.rows.find((item) => item.id === id);
      if (row) row.logs = String(logs);
      return { rows: [] };
    }
    if (text.includes("FROM") && text.includes("_prisma_migrations")) {
      return {
        rows: this.rows.map((row) => ({
          id: row.id,
          checksum: row.checksum,
          migration_name: row.migrationName,
          finished_at: row.finishedAt,
          rolled_back_at: row.rolledBackAt,
          logs: row.logs,
        })),
      };
    }
    if (!text.includes("_prisma_migrations") && !text.startsWith("SELECT pg_advisory")) {
      this.scripts.push(text);
    }
    return { rows: [] };
  }
}

describe("sql migration runner", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("applies every migration in order, records checksums, and is idempotent", async () => {
    const expected = await listSqlMigrations(migrationsDir);
    expect(expected.length).toBeGreaterThan(50);
    const client = new MemoryMigrations();
    const first = await applySqlMigrations({ client, migrationsDir });
    expect(first.applied).toEqual(expected.map((migration) => migration.name));
    expect(client.rows.map((row) => row.migrationName)).toEqual(first.applied);
    expect(client.rows.every((row) => row.finishedAt !== null && row.appliedStepsCount > 0)).toBe(
      true,
    );
    for (const migration of expected) {
      const row = client.rows.find((item) => item.migrationName === migration.name);
      expect(row?.checksum).toBe(migration.checksum);
      expect(row?.checksum).toBe(migrationChecksum(migration.sql));
    }
    const concurrent = expected.find((migration) => migration.name.includes("idx_concurrent"));
    expect(concurrent).toBeDefined();
    const concurrentScripts = client.scripts.filter((script) => script.includes("CONCURRENTLY"));
    expect(concurrentScripts.some((script) => script.startsWith("BEGIN"))).toBe(false);
    const transactional = client.scripts.find((script) => script.startsWith("BEGIN"));
    expect(transactional).toBeDefined();

    const before = client.scripts.length;
    const second = await applySqlMigrations({ client, migrationsDir });
    expect(second.applied).toEqual([]);
    expect(client.scripts).toHaveLength(before);
    expect(client.rows).toHaveLength(expected.length);
  });

  it("refuses a database whose recorded checksum does not match the file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "migrate-sql-"));
    directories.push(root);
    const migrations = path.join(root, "migrations");
    await mkdir(path.join(migrations, "20260101000000_init"), { recursive: true });
    await mkdir(path.join(migrations, "20260102000000_next"), { recursive: true });
    await writeFile(path.join(migrations, "20260101000000_init", "migration.sql"), "SELECT 1;\n");
    await writeFile(path.join(migrations, "20260102000000_next", "migration.sql"), "SELECT 2;\n");
    const client = new MemoryMigrations();
    client.rows.push({
      id: "seeded",
      checksum: "0".repeat(64),
      migrationName: "20260101000000_init",
      finishedAt: "finished",
      rolledBackAt: null,
      logs: null,
      appliedStepsCount: 1,
    });
    await expect(applySqlMigrations({ client, migrationsDir: migrations })).rejects.toThrow(
      MigrationHistoryError,
    );
    await expect(applySqlMigrations({ client, migrationsDir: migrations })).rejects.toThrow(
      /was modified after it was applied/,
    );
    expect(client.scripts).toEqual([]);
    expect(client.rows.map((row) => row.migrationName)).toEqual(["20260101000000_init"]);
    expect(client.rows[0]?.checksum).toBe("0".repeat(64));
  });

  it("leaves no history row when a migration's SQL fails, and applies it once the cause is fixed", async () => {
    const migrations = await fixtureMigrations({
      "20260101000000_init": "CREATE TABLE widgets (id int);\n",
      "20260102000000_next":
        "INSERT INTO widgets SELECT 1;\nALTER TABLE widgets ADD COLUMN name text;\n",
    });
    const client = new MemoryMigrations();
    client.failOn = "ALTER TABLE widgets";
    const failure = await applySqlMigrations({ client, migrationsDir: migrations }).catch(
      (error: unknown) => error,
    );
    expect(client.rows.map((row) => [row.migrationName, row.finishedAt])).toEqual([
      ["20260101000000_init", "finished"],
    ]);
    expect(failure).toBeInstanceOf(MigrationApplyError);
    expect((failure as Error).message).toBe(
      'Migration "20260102000000_next" failed to apply. relation "widgets" does not exist',
    );

    client.failOn = null;
    const retried = await applySqlMigrations({ client, migrationsDir: migrations });
    expect(retried.applied).toEqual(["20260102000000_next"]);
    expect(client.rows.every((row) => row.finishedAt === "finished")).toBe(true);
  });

  it("marks a failed CONCURRENTLY migration rolled back so the next run applies it", async () => {
    const migrations = await fixtureMigrations({
      "20260101000000_idx_concurrent":
        "CREATE INDEX CONCURRENTLY widgets_id_idx ON widgets (id);\n",
    });
    const client = new MemoryMigrations();
    client.failOn = "CONCURRENTLY";
    const failure = await applySqlMigrations({ client, migrationsDir: migrations }).catch(
      (error: unknown) => error,
    );
    expect(client.rows).toMatchObject([{ finishedAt: null, rolledBackAt: "rolled back" }]);
    expect(failure).toMatchObject({
      name: "MigrationApplyError",
      message: expect.stringContaining("20260101000000_idx_concurrent"),
    });

    client.failOn = null;
    const retried = await applySqlMigrations({ client, migrationsDir: migrations });
    expect(retried.applied).toEqual(["20260101000000_idx_concurrent"]);
    expect(client.rows.at(-1)).toMatchObject({ finishedAt: "finished", rolledBackAt: null });
  });

  it("drops an INVALID index an interrupted build left, then builds it again", async () => {
    const migrations = await fixtureMigrations({
      "20260101000000_idx_concurrent":
        '-- builds "not_this_idx" in a comment only\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Widgets_Id_idx" ON widgets (id);\n',
      "20260102000000_unnamed_idx_concurrent": "CREATE INDEX CONCURRENTLY ON widgets (name);\n",
    });
    const client = new MemoryMigrations();
    client.indexes.set("public.Widgets_Id_idx", false).set("public.other_idx", false);
    const result = await applySqlMigrations({ client, migrationsDir: migrations });
    expect(result.applied).toHaveLength(2);
    expect([...client.indexes.keys()]).toEqual(["public.other_idx"]);
    const drop = client.scripts.indexOf("DROP INDEX CONCURRENTLY IF EXISTS public.Widgets_Id_idx");
    const build = client.scripts.findIndex((script) => script.includes("CREATE UNIQUE INDEX"));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(drop).toBeLessThan(build);
    expect(client.scripts.some((script) => script.includes("not_this_idx"))).toBe(true);
    expect(client.scripts.filter((script) => script.startsWith("DROP INDEX"))).toHaveLength(1);
  });

  it("applies again a CONCURRENTLY migration whose run was cut off before it finished", async () => {
    const migrations = await fixtureMigrations({
      "20260101000000_idx_concurrent":
        "CREATE INDEX CONCURRENTLY widgets_id_idx ON widgets (id);\n",
    });
    const client = new MemoryMigrations();
    const [migration] = await listSqlMigrations(migrations);
    // The server stopped mid-build: neither finished nor rolled back.
    client.rows.push({
      id: "cut-off",
      checksum: migration!.checksum,
      migrationName: migration!.name,
      finishedAt: null,
      rolledBackAt: null,
      logs: null,
      appliedStepsCount: 0,
    });
    const result = await applySqlMigrations({ client, migrationsDir: migrations });
    expect(result.applied).toEqual(["20260101000000_idx_concurrent"]);
    expect(client.rows).toMatchObject([
      { id: "cut-off", finishedAt: null, rolledBackAt: "rolled back" },
      { finishedAt: "finished", rolledBackAt: null },
    ]);
  });

  it.each([
    [
      "an index it built",
      'CREATE INDEX CONCURRENTLY "Widgets_Id_idx" ON widgets (id);\n',
      (client: MemoryMigrations) => client.indexes.set("public.Widgets_Id_idx", true),
    ],
    [
      "an index it dropped",
      "DROP INDEX CONCURRENTLY IF EXISTS public.old_idx;\n",
      (_client: MemoryMigrations) => undefined,
    ],
  ])(
    "marks a cut-off CONCURRENTLY row finished when %s is already in place",
    async (_what, sql, done) => {
      const migrations = await fixtureMigrations({ "20260101000000_idx_concurrent": sql });
      const client = new MemoryMigrations();
      const [migration] = await listSqlMigrations(migrations);
      done(client);
      // The build finished, but the app quit before the row was marked.
      client.rows.push({
        id: "cut-off",
        checksum: migration!.checksum,
        migrationName: migration!.name,
        finishedAt: null,
        rolledBackAt: null,
        logs: null,
        appliedStepsCount: 0,
      });
      for (let start = 0; start < 2; start += 1) {
        expect(await applySqlMigrations({ client, migrationsDir: migrations })).toEqual({
          applied: [],
        });
      }
      expect(client.rows).toMatchObject([
        { id: "cut-off", finishedAt: "finished", rolledBackAt: null, appliedStepsCount: 1 },
      ]);
      expect(client.scripts.filter((script) => script.includes("CONCURRENTLY"))).toEqual([]);
    },
  );

  it("rolls a CONCURRENTLY row back when it cannot be marked finished, and records it next time", async () => {
    const migrations = await fixtureMigrations({
      "20260101000000_idx_concurrent":
        "CREATE INDEX CONCURRENTLY widgets_id_idx ON widgets (id);\n",
    });
    const client = new MemoryMigrations();
    client.failFinish = true;
    const failure = await applySqlMigrations({ client, migrationsDir: migrations }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationApplyError);
    expect(client.rows).toMatchObject([{ finishedAt: null, rolledBackAt: "rolled back" }]);

    // The build itself had finished.
    client.failFinish = false;
    client.indexes.set("public.widgets_id_idx", true);
    expect(await applySqlMigrations({ client, migrationsDir: migrations })).toEqual({
      applied: [],
    });
    expect(client.rows).toMatchObject([
      { rolledBackAt: "rolled back" },
      { finishedAt: "finished", rolledBackAt: null },
    ]);
    expect(client.scripts.filter((script) => script.includes("CREATE INDEX"))).toHaveLength(1);
  });

  it("still refuses an unfinished transactional migration another tool left", async () => {
    const migrations = await fixtureMigrations({ "20260101000000_init": "SELECT 1;\n" });
    const client = new MemoryMigrations();
    const [migration] = await listSqlMigrations(migrations);
    client.rows.push({
      id: "external",
      checksum: migration!.checksum,
      migrationName: migration!.name,
      finishedAt: null,
      rolledBackAt: null,
      logs: null,
      appliedStepsCount: 0,
    });
    await expect(applySqlMigrations({ client, migrationsDir: migrations })).rejects.toMatchObject({
      name: "MigrationHistoryError",
      reason: "unfinished",
    });
    expect(client.scripts).toEqual([]);
  });

  it("stops between migrations once aborted, and names why the history is refused", async () => {
    const migrations = await fixtureMigrations({
      "20260101000000_one": "SELECT 1;\n",
      "20260102000000_two": "SELECT 2;\n",
    });
    const client = new MemoryMigrations();
    const abort = new AbortController();
    const query = client.query.bind(client);
    client.query = async (text, values) => {
      const result = await query(text, values);
      if (text === "COMMIT") abort.abort(new Error("stopping"));
      return result;
    };
    await expect(
      applySqlMigrations({ client, migrationsDir: migrations, signal: abort.signal }),
    ).rejects.toThrow("stopping");
    expect(client.rows.map((row) => row.migrationName)).toEqual(["20260101000000_one"]);

    client.rows.push({
      id: "future",
      checksum: "0".repeat(64),
      migrationName: "20990101000000_future",
      finishedAt: "finished",
      rolledBackAt: null,
      logs: null,
      appliedStepsCount: 1,
    });
    await expect(applySqlMigrations({ client, migrationsDir: migrations })).rejects.toMatchObject({
      reason: "newer",
    });
  });

  async function fixtureMigrations(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "migrate-sql-"));
    directories.push(root);
    const migrations = path.join(root, "migrations");
    for (const [name, sql] of Object.entries(files)) {
      await mkdir(path.join(migrations, name), { recursive: true });
      await writeFile(path.join(migrations, name, "migration.sql"), sql);
    }
    return migrations;
  }
});
