import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { Server } from "node:net";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { applySqlMigrationsToDatabase, ensureApplicationDatabase } from "@ardurbot/db/migrate";
import { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalModeDependencies } from "./local-mode.js";
import { LocalModeController, migrationsDir } from "./local-mode.js";
import type { EmbeddedPostgresBinaries, EmbeddedPostgresLike } from "./local-postgres.js";
import {
  loadEmbeddedPostgres,
  MissingDatabaseBinariesError,
  POSTGRES_USER,
  postgresServesFolder,
  stopOwnedPostgres,
  stopWithPgCtl,
} from "./local-postgres.js";

/**
 * These tests run the real embedded Postgres the desktop app ships. Linux CI installs the
 * platform package with the workspace; elsewhere they are skipped with the reason.
 */
const binaries = await loadEmbeddedPostgres({ packaged: false, resourcesPath: "" }).catch(
  (error: unknown) => {
    if (error instanceof MissingDatabaseBinariesError) return null;
    throw error;
  },
);
const skipReason =
  binaries === null
    ? "The embedded Postgres binaries for this platform are not installed."
    : process.getuid?.() === 0
      ? "Postgres refuses to run as root."
      : null;

const repoMigrations = migrationsDir({
  packaged: false,
  resourcesPath: "",
  appPath: path.resolve(import.meta.dirname, ".."),
});
const directories: string[] = [];
const servers: Server[] = [];
const clusters: EmbeddedPostgresLike[] = [];

afterEach(async () => {
  await Promise.all(clusters.splice(0).map((cluster) => stopOwnedPostgres(cluster)));
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

if (skipReason !== null) it.skip(`embedded Postgres: ${skipReason}`, () => undefined);

describe.skipIf(skipReason !== null)("embedded Postgres", () => {
  const real = binaries as EmbeddedPostgresBinaries;

  it("applies the real migrations once, as prisma migrate deploy records them", {
    timeout: 180_000,
  }, async () => {
    const { url } = await cluster();
    await ensureApplicationDatabase(url);
    const all = (await readdir(repoMigrations, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
    const first = await applySqlMigrationsToDatabase({
      connectionString: url,
      migrationsDir: repoMigrations,
    });
    expect(first.applied).toHaveLength(all.length);
    expect(
      await applySqlMigrationsToDatabase({ connectionString: url, migrationsDir: repoMigrations }),
    ).toEqual({ applied: [] });
    const rows = await query<{ unfinished: number; steps: number[] }>(
      url,
      `SELECT count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)::int AS unfinished,
              array_agg(DISTINCT applied_steps_count) AS steps
         FROM _prisma_migrations`,
    );
    expect(rows[0]).toEqual({ unfinished: 0, steps: [1] });
  });

  it("sends each migration file as one query, so escaped strings and concurrent indexes apply", {
    timeout: 120_000,
  }, async () => {
    const { url } = await cluster();
    const migrations = await temporary("migrations-");
    const files = {
      "20260101000000_notes": "CREATE TABLE notes (body text);\n",
      // A semicolon inside an escaped string literal is part of the value.
      "20260102000000_escaped":
        "INSERT INTO notes VALUES (E'it\\'s; fine');\nINSERT INTO notes VALUES ('two');\n",
      "20260103000000_notes_idx_concurrent":
        "CREATE INDEX CONCURRENTLY notes_body_idx ON notes (body);\n",
    };
    for (const [name, sql] of Object.entries(files)) {
      await mkdir(path.join(migrations, name));
      await writeFile(path.join(migrations, name, "migration.sql"), sql);
    }
    await ensureApplicationDatabase(url);
    expect(
      (await applySqlMigrationsToDatabase({ connectionString: url, migrationsDir: migrations }))
        .applied,
    ).toEqual(Object.keys(files));
    expect(await query<{ body: string }>(url, "SELECT body FROM notes ORDER BY body")).toEqual([
      { body: "it's; fine" },
      { body: "two" },
    ]);
    expect(
      await query(url, "SELECT 1 FROM pg_indexes WHERE indexname = 'notes_body_idx'"),
    ).toHaveLength(1);
  });

  it("settles with a sentence when the database cannot start, instead of waiting forever", {
    timeout: 120_000,
  }, async () => {
    const userData = await temporary("local-mode-");
    const held = await holdPort();
    const controller = new LocalModeController(
      dependencies(userData, {
        allocatePort: async () => held,
        portAvailable: async () => true,
      }),
    );
    const state = await within(90_000, controller.start());
    expect(state).toMatchObject({
      phase: "failed",
      message: "The database could not start. Retry, or restart the computer if it happens again.",
    });
    expect(controller.running()).toBe(false);
    await within(5_000, controller.stop());
  });

  it("uses a server an earlier run left only after it proves it serves the folder, and stops it with pg_ctl", {
    timeout: 120_000,
  }, async () => {
    const userData = await temporary("local-mode-");
    const password = "a".repeat(32);
    await writeFile(
      path.join(userData, "secrets.env"),
      `POSTGRES_PASSWORD=${password}\nENCRYPTION_KEY=${"b".repeat(64)}\n`,
      { mode: 0o600 },
    );
    const databaseDir = path.join(userData, "postgres");
    const left = await cluster({ databaseDir, password });
    expect(await postgresServesFolder({ port: left.port, password, databaseDir })).toBe(true);
    expect(await postgresServesFolder({ port: left.port, password, databaseDir: userData })).toBe(
      false,
    );

    let factoryCalls = 0;
    const controller = new LocalModeController(
      dependencies(userData, {
        allocatePort: async () => left.port + 1,
        portAvailable: async (port) => port !== left.port,
        postgresFactory: () => {
          factoryCalls += 1;
          throw new Error("a second server must not start");
        },
      }),
    );
    expect(await within(60_000, controller.start())).toMatchObject({ phase: "ready" });
    expect(factoryCalls).toBe(0);
    await within(30_000, controller.stop());
    expect(await postgresServesFolder({ port: left.port, password, databaseDir })).toBe(false);
    await expect(stat(path.join(databaseDir, "postmaster.pid"))).rejects.toThrow();
  });

  async function cluster(input: { databaseDir?: string; password?: string } = {}) {
    const databaseDir = input.databaseDir ?? path.join(await temporary("pg-"), "data");
    const password = input.password ?? "c".repeat(32);
    const port = await freePort();
    const postgres = new real.EmbeddedPostgres({
      databaseDir,
      port,
      user: POSTGRES_USER,
      password,
      persistent: true,
      authMethod: "scram-sha-256",
      postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
      onLog: () => undefined,
      onError: () => undefined,
    });
    clusters.push(postgres);
    await postgres.initialise();
    await postgres.start();
    return {
      port,
      url: `postgres://${POSTGRES_USER}:${password}@127.0.0.1:${port}/ardurbot`,
    };
  }

  function dependencies(
    userDataDir: string,
    overrides: Pick<LocalModeDependencies, "allocatePort" | "portAvailable"> &
      Partial<LocalModeDependencies>,
  ): LocalModeDependencies {
    return {
      userDataDir,
      packaged: false,
      resourcesPath: "",
      appPath: path.resolve(import.meta.dirname, ".."),
      execPath: process.execPath,
      platform: process.platform,
      env: { PATH: process.env.PATH ?? "" },
      spawn: (_command, args) => {
        const child = Object.assign(new EventEmitter(), {
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          exitCode: null,
          signalCode: null,
          kill: () => {
            queueMicrotask(() => child.emit("exit", 0));
            return true;
          },
        });
        if (args.some((arg) => arg.includes("worker"))) {
          queueMicrotask(() =>
            child.stdout.emit("data", Buffer.from('{"message":"worker ready"}\n')),
          );
        }
        return child as unknown as ChildProcess;
      },
      fetch: async () =>
        new Response(JSON.stringify({ json: { ok: true, version: "0.1.0" } }), { status: 200 }),
      migrate: ensureApplicationDatabase,
      postgresFactory: (options) => {
        const postgres = new real.EmbeddedPostgres({ ...options, onLog: () => undefined });
        clusters.push(postgres);
        return postgres;
      },
      stopAdoptedPostgres: (databaseDir) => stopWithPgCtl(real.pgCtl, databaseDir),
      randomHex: (bytes) => "d".repeat(bytes * 2),
      now: () => Date.now(),
      ...overrides,
    };
  }
});

async function temporary(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

async function query<T = unknown>(url: string, text: string): Promise<T[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query(text)).rows as T[];
  } finally {
    await client.end();
  }
}

async function freePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    await new Promise((resolve) => server.close(resolve));
    if (address !== null && typeof address === "object" && ![5432, 5433].includes(address.port)) {
      return address.port;
    }
  }
}

/** A listener on the port Postgres will be told to use, so its start fails. */
async function holdPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    }),
  ]);
}
