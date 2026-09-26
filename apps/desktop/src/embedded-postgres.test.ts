import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  loopbackPortAvailable,
  MissingDatabaseBinariesError,
  POSTGRES_USER,
  postgresProcess,
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
    await ensureApplicationDatabase({ adminUrl: url, databaseUrl: url });
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
    await ensureApplicationDatabase({ adminUrl: url, databaseUrl: url });
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

  it("says the database stopped when a server an earlier run left stops after ready", {
    timeout: 120_000,
  }, async () => {
    const userData = await temporary("local-mode-");
    const password = "a".repeat(32);
    await writeFile(
      path.join(userData, "secrets.env"),
      `POSTGRES_PASSWORD=${password}\nENCRYPTION_KEY=${"b".repeat(64)}\n`,
      { mode: 0o600 },
    );
    const left = await cluster({ databaseDir: path.join(userData, "postgres"), password });
    const failed: string[] = [];
    const controller = new LocalModeController(
      dependencies(userData, {
        allocatePort: async () => left.port + 1,
        portAvailable: async (port) => port !== left.port,
        adoptedCheckMs: 200,
        onFailed: (message) => {
          failed.push(message);
        },
        postgresFactory: () => {
          throw new Error("a second server must not start");
        },
      }),
    );
    expect(await within(60_000, controller.start())).toMatchObject({ phase: "ready" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(controller.state().phase).toBe("ready");

    await left.postgres.stop();
    await until(30_000, async () => controller.state().phase === "failed");
    expect(controller.state()).toMatchObject({ message: "The database stopped." });
    expect(failed).toEqual(["The database stopped."]);
    await within(30_000, controller.stop());
  });

  it("runs as its own application role, and keeps initdb's password out of the system temp folder", {
    timeout: 180_000,
  }, async () => {
    const userData = await temporary("local-mode-");
    // A system temp folder nobody may write: the old library path wrote the password here.
    const systemTemp = await temporary("system-temp-");
    await chmod(systemTemp, 0o500);
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const envs: NodeJS.ProcessEnv[] = [];
    const controller = new LocalModeController(
      dependencies(userData, {
        allocatePort: freePort,
        portAvailable: async () => true,
        migrate: migrateWith(repoMigrations),
        spawn: recordingSpawn(envs),
      }),
    );
    let state: Awaited<ReturnType<LocalModeController["start"]>>;
    try {
      Object.assign(process.env, { TMPDIR: systemTemp, TEMP: systemTemp, TMP: systemTemp });
      state = await within(150_000, controller.start());
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await chmod(systemTemp, 0o700);
    }
    expect(state).toMatchObject({ phase: "ready" });
    expect(await readdir(systemTemp)).toEqual([]);
    expect((await readdir(userData)).filter((name) => name.startsWith("initdb-"))).toEqual([]);

    const databaseUrl = envs[0]?.DATABASE_URL ?? "";
    expect(new URL(databaseUrl).username).toBe("ardurbot_app");
    expect(await query(databaseUrl, "SELECT current_user AS who")).toEqual([
      { who: "ardurbot_app" },
    ]);
    const admin = new URL(databaseUrl);
    admin.username = "ardurbot";
    admin.password = /^POSTGRES_PASSWORD=(.+)$/m.exec(
      await (await import("node:fs/promises")).readFile(path.join(userData, "secrets.env"), "utf8"),
    )![1]!;
    expect(
      await query(
        admin.href,
        `SELECT r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls,
                (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'ardurbot') AS owner,
                (SELECT count(*)::int FROM pg_class WHERE relnamespace = 'public'::regnamespace
                    AND pg_get_userbyid(relowner) <> 'ardurbot_app') AS foreign_objects
           FROM pg_roles r WHERE r.rolname = 'ardurbot_app'`,
      ),
    ).toEqual([
      {
        rolsuper: false,
        rolcreaterole: false,
        rolcreatedb: false,
        rolreplication: false,
        rolbypassrls: false,
        owner: "ardurbot_app",
        foreign_objects: 0,
      },
    ]);
    await within(30_000, controller.stop());
  });

  it("stops during migrations without crashing, once the migration in flight is cancelled", {
    timeout: 120_000,
  }, async () => {
    const userData = await temporary("local-mode-");
    const migrations = await temporary("migrations-");
    await mkdir(path.join(migrations, "20260101000000_slow"));
    await writeFile(
      path.join(migrations, "20260101000000_slow", "migration.sql"),
      "SELECT pg_sleep(60);\n",
    );
    let postgres: EmbeddedPostgresLike | undefined;
    const controller = new LocalModeController(
      dependencies(userData, {
        allocatePort: freePort,
        portAvailable: async () => true,
        migrate: migrateWith(migrations),
        postgresFactory: (options) => {
          postgres = new real.EmbeddedPostgres({ ...options, onLog: () => undefined });
          clusters.push(postgres);
          return postgres;
        },
      }),
    );
    const started = controller.start();
    await until(90_000, async () => {
      if (controller.state().phase !== "migrations") return false;
      const port = Number(
        (
          await (
            await import("node:fs/promises")
          ).readFile(path.join(userData, "postgres.port"), "utf8")
        ).trim(),
      );
      const password = "d".repeat(32);
      const rows = await query(
        `postgres://ardurbot:${password}@127.0.0.1:${port}/ardurbot`,
        "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(60)%'",
      ).catch(() => []);
      return rows.length > 0;
    });
    const began = Date.now();
    expect(await uncaughtDuring(() => within(20_000, controller.stop()))).toEqual([]);
    expect(Date.now() - began).toBeLessThan(20_000);
    await started;
    expect(controller.state().phase).toBe("idle");
    expect(postgresProcessExited(postgres)).toBe(true);
  });

  it("rejects instead of crashing when the server stops under a migration", {
    timeout: 120_000,
  }, async () => {
    const { url, postgres } = await cluster();
    await ensureApplicationDatabase({ adminUrl: url, databaseUrl: url });
    const migrations = await temporary("migrations-");
    await mkdir(path.join(migrations, "20260101000000_slow"));
    await writeFile(
      path.join(migrations, "20260101000000_slow", "migration.sql"),
      "SELECT pg_sleep(60);\n",
    );
    // Settles to the error at once, so the rejection is observed when it happens.
    const running = applySqlMigrationsToDatabase({
      connectionString: url,
      migrationsDir: migrations,
    }).then(
      () => null,
      (error: unknown) => error,
    );
    await until(
      30_000,
      async () =>
        (await query(url, "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'SELECT pg_sleep(60)%'"))
          .length > 0,
    );
    expect(await uncaughtDuring(() => postgres.stop())).toEqual([]);
    expect(await within(10_000, running)).toBeInstanceOf(Error);
  });

  it.each(["cancelled", "stopped by the server"] as const)(
    "applies a CONCURRENTLY migration again after it was %s mid-build",
    { timeout: 120_000 },
    async (how) => {
      const { url, postgres } = await cluster();
      await ensureApplicationDatabase({ adminUrl: url, databaseUrl: url });
      await query(url, "CREATE TABLE widgets AS SELECT g AS val FROM generate_series(1, 1000) g");
      const migrations = await temporary("migrations-");
      await mkdir(path.join(migrations, "20260101000000_widgets_idx_concurrent"));
      await writeFile(
        path.join(migrations, "20260101000000_widgets_idx_concurrent", "migration.sql"),
        'CREATE INDEX CONCURRENTLY "widgets_val_idx" ON widgets (val);\n',
      );
      // An open writer makes the build wait after its INVALID index is committed.
      const writer = new Client({ connectionString: url });
      writer.on("error", () => undefined);
      await writer.connect();
      await writer.query("BEGIN; LOCK TABLE widgets IN ROW EXCLUSIVE MODE");
      const first = applySqlMigrationsToDatabase({
        connectionString: url,
        migrationsDir: migrations,
      }).then(
        () => "applied",
        () => "failed",
      );
      const building = async () =>
        query<{ pid: number }>(
          url,
          "SELECT pid FROM pg_stat_activity WHERE query LIKE 'CREATE INDEX CONCURRENTLY%' AND wait_event_type = 'Lock'",
        );
      await until(30_000, async () => (await building()).length > 0);
      if (how === "cancelled") {
        await query(url, `SELECT pg_cancel_backend(${(await building())[0]!.pid})`);
      } else {
        await postgres.stop();
      }
      expect(await within(10_000, first)).toBe("failed");
      await writer.end().catch(() => undefined);
      if (how !== "cancelled") await postgres.start();
      expect(await indexValidity(url)).toEqual([{ indisvalid: false }]);

      const retry = await applySqlMigrationsToDatabase({
        connectionString: url,
        migrationsDir: migrations,
      });
      expect(retry.applied).toEqual(["20260101000000_widgets_idx_concurrent"]);
      expect(await indexValidity(url)).toEqual([{ indisvalid: true }]);
      expect(
        await query(
          url,
          `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
             FROM _prisma_migrations ORDER BY started_at`,
        ),
      ).toEqual([
        { finished: false, rolled_back: true },
        { finished: true, rolled_back: false },
      ]);
    },
  );

  it.each([
    ["the app quit before its row was marked", "finished_at = NULL"],
    ["marking its row was cancelled", "finished_at = NULL, rolled_back_at = CURRENT_TIMESTAMP"],
  ] as const)(
    "records a CONCURRENTLY index that was built but %s, instead of building it again",
    {
      timeout: 120_000,
    },
    async (_how, leftBehind) => {
      const { url } = await cluster();
      await ensureApplicationDatabase({ adminUrl: url, databaseUrl: url });
      await query(url, "CREATE TABLE widgets AS SELECT g AS val FROM generate_series(1, 1000) g");
      const migrations = await temporary("migrations-");
      await mkdir(path.join(migrations, "20260101000000_widgets_idx_concurrent"));
      await writeFile(
        path.join(migrations, "20260101000000_widgets_idx_concurrent", "migration.sql"),
        'CREATE INDEX CONCURRENTLY "widgets_val_idx" ON widgets (val);\n',
      );
      await applySqlMigrationsToDatabase({ connectionString: url, migrationsDir: migrations });
      await query(url, `UPDATE _prisma_migrations SET ${leftBehind}`);

      for (let start = 0; start < 2; start += 1) {
        expect(
          await applySqlMigrationsToDatabase({ connectionString: url, migrationsDir: migrations }),
        ).toEqual({ applied: [] });
      }
      expect(await indexValidity(url)).toEqual([{ indisvalid: true }]);
      const rows = await query<{ finished: boolean; rolled_back: boolean }>(
        url,
        `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
         FROM _prisma_migrations ORDER BY started_at`,
      );
      expect(rows.at(-1)).toEqual({ finished: true, rolled_back: false });
      expect(rows).toHaveLength(leftBehind === "finished_at = NULL" ? 1 : 2);
    },
  );

  it("keeps using and watching its running database when Retry follows a worker that gave up", {
    timeout: 120_000,
  }, async () => {
    const userData = await temporary("local-mode-");
    const failed: string[] = [];
    let factoryCalls = 0;
    let postgres: EmbeddedPostgresLike | undefined;
    // The worker exits at once until it has used its restarts, then reports ready.
    const workerFates = ["exits", "exits", "exits", "exits"];
    const controller = new LocalModeController(
      dependencies(userData, {
        allocatePort: freePort,
        portAvailable: loopbackPortAvailable,
        restartDelayMs: () => 0,
        spawn: scriptedSpawn(workerFates),
        onFailed: (message) => {
          failed.push(message);
        },
        postgresFactory: (options) => {
          factoryCalls += 1;
          postgres = new real.EmbeddedPostgres({ ...options, onLog: () => undefined });
          clusters.push(postgres);
          return postgres;
        },
      }),
    );
    expect(await within(60_000, controller.start())).toMatchObject({
      phase: "failed",
      message: "The worker stopped.",
    });
    expect(await within(60_000, controller.start())).toMatchObject({ phase: "ready" });
    expect(factoryCalls).toBe(1);

    postgresProcess(postgres!)!.kill("SIGINT");
    await until(30_000, async () => controller.state().phase === "failed");
    expect(controller.state()).toMatchObject({ message: "The database stopped." });
    expect(failed).toEqual(["The worker stopped.", "The database stopped."]);
    await within(30_000, controller.stop());
  });

  it("says the database stopped when its process exits after ready, and Retry starts it again", {
    timeout: 120_000,
  }, async () => {
    const userData = await temporary("local-mode-");
    const failed: string[] = [];
    let postgres: EmbeddedPostgresLike | undefined;
    const controller = new LocalModeController(
      dependencies(userData, {
        allocatePort: freePort,
        portAvailable: async () => true,
        onFailed: (message) => {
          failed.push(message);
        },
        postgresFactory: (options) => {
          postgres = new real.EmbeddedPostgres({ ...options, onLog: () => undefined });
          clusters.push(postgres);
          return postgres;
        },
      }),
    );
    expect(await within(60_000, controller.start())).toMatchObject({ phase: "ready" });
    const first = postgres;
    postgresProcess(first!)!.kill("SIGINT");
    await until(30_000, async () => controller.state().phase === "failed");
    expect(controller.state()).toMatchObject({ message: "The database stopped." });
    expect(failed).toEqual(["The database stopped."]);
    expect(await within(60_000, controller.start())).toMatchObject({ phase: "ready" });
    expect(postgres).not.toBe(first);
    await within(30_000, controller.stop());
  });

  function migrateWith(migrationsDir: string): LocalModeDependencies["migrate"] {
    return async ({ adminUrl, databaseUrl, signal }) => {
      await ensureApplicationDatabase({ adminUrl, databaseUrl, signal });
      await applySqlMigrationsToDatabase({ connectionString: databaseUrl, migrationsDir, signal });
    };
  }

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
      postgres,
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
      spawn: recordingSpawn([]),
      fetch: async () =>
        new Response(JSON.stringify({ json: { ok: true, version: "0.1.0" } }), { status: 200 }),
      migrate: ({ adminUrl, databaseUrl, signal }) =>
        ensureApplicationDatabase({ adminUrl, databaseUrl, signal }),
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

/** Services that report ready at once; each spawn's environment is kept. */
function recordingSpawn(envs: NodeJS.ProcessEnv[]): LocalModeDependencies["spawn"] {
  return scriptedSpawn([], envs);
}

/** Like `recordingSpawn`, but each worker takes the next fate: exit at once, or report ready. */
function scriptedSpawn(
  workerFates: string[],
  envs: NodeJS.ProcessEnv[] = [],
): LocalModeDependencies["spawn"] {
  return (_command, args, options) => {
    envs.push(options.env ?? {});
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
      const exits = workerFates.shift() === "exits";
      queueMicrotask(() =>
        exits
          ? child.emit("exit", 1)
          : child.stdout.emit("data", Buffer.from('{"message":"worker ready"}\n')),
      );
    }
    return child as unknown as ChildProcess;
  };
}

function postgresProcessExited(postgres: EmbeddedPostgresLike | undefined): boolean {
  const child = postgres ? postgresProcess(postgres) : undefined;
  return child === undefined || child.exitCode !== null || child.signalCode !== null;
}

async function indexValidity(url: string) {
  return query<{ indisvalid: boolean }>(
    url,
    `SELECT i.indisvalid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname = 'widgets_val_idx'`,
  );
}

/** Errors nothing handled while `work` ran; in Electron's main process each one is fatal. */
async function uncaughtDuring(work: () => Promise<unknown>): Promise<string[]> {
  const seen: string[] = [];
  const record = (error: Error) => {
    seen.push(error.message);
  };
  process.on("uncaughtException", record);
  try {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    process.off("uncaughtException", record);
  }
  return seen;
}

/** Polls until `check` holds, so a slow CI machine waits instead of failing. */
async function until(ms: number, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`still waiting after ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function temporary(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(dir);
  return dir;
}

async function query<T = unknown>(url: string, text: string): Promise<T[]> {
  const client = new Client({ connectionString: url });
  client.on("error", () => undefined);
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
