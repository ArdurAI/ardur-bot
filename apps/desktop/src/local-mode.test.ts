import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { MigrationApplyError, MigrationHistoryError } from "@ardurbot/db/migrate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { localFoldersFile } from "./local-folders.js";
import { appendCappedLog, LOG_CAP_BYTES } from "./local-logs.js";
import {
  LocalModeController,
  localResetFailure,
  localServiceLaunch,
  resetMoveFailure,
} from "./local-mode.js";
import type { EmbeddedPostgresLike, EmbeddedPostgresOptions } from "./local-postgres.js";
import { MissingDatabaseBinariesError, postgresServesFolder } from "./local-postgres.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function userData(): Promise<string> {
  const dir = await mkdirTemp();
  return dir;
}

async function mkdirTemp(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "local-mode-"));
  directories.push(dir);
  return dir;
}

function healthResponse(): Response {
  return new Response(JSON.stringify({ json: { ok: true, version: "0.1.0" } }), { status: 200 });
}

function fakeChild(): ChildProcess & { stdout: EventEmitter; stderr: EventEmitter } {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    stdout,
    stderr,
    stdin: null,
    kill: vi.fn((signal?: NodeJS.Signals) => {
      queueMicrotask(() => child.emit("exit", signal === "SIGKILL" ? 137 : 0, signal));
      return true;
    }),
  });
  return child as unknown as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
}

describe("local mode start", () => {
  it("starts without docker or compose and opens the app when Postgres and the API answer", async () => {
    const root = await userData();
    const spawned: string[][] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    let port = 0;
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        spawn: (command, args, options) => {
          spawned.push([command, ...args]);
          envs.push(options.env ?? {});
          return fakeChild();
        },
        postgresFactory: (options) => {
          port = options.port;
          return runningPostgres();
        },
      }),
    );
    const state = await controller.start();
    expect(state.phase).toBe("ready");
    expect(spawned.some((args) => args.some((arg) => /docker|compose/.test(arg)))).toBe(false);
    expect(spawned.length).toBeGreaterThan(0);
    expect(controller.origin()).toBe(`http://127.0.0.1:${port}`);
    expect(envs.length).toBeGreaterThan(0);
    for (const env of envs) {
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(env.ARDURBOT_HOST_BRIDGE).toBeUndefined();
      expect(env.SANDBOX_PROVIDER).toBe("desktop");
      expect(env.DATA_DIR).toBe(path.join(root, "data"));
      expect(env.DATABASE_URL).toContain(`127.0.0.1:${port}`);
      expect(env.DATABASE_URL).not.toContain(":5433");
      expect(env.BETTER_AUTH_URL).toBe(`http://127.0.0.1:${port}`);
      expect(env.WEB_ORIGIN).toBe(`http://127.0.0.1:${port}`);
      expect(env.API_URL).toBe(`http://127.0.0.1:${port}`);
      expect(env.SANDBOX_SUPERVISOR_TOKEN?.length).toBeGreaterThanOrEqual(32);
      // Local mode's own folder list; a pairing with another server is never read.
      expect(env.ARDURBOT_HOST_ROOTS_FILE).toBe(localFoldersFile(root));
      expect(env.LOG_FORMAT).toBe("json");
    }
    expect(port).not.toBe(5432);
    expect(port).not.toBe(5433);
    const api = spawned.find((args) =>
      args.some((arg) => arg.endsWith("index.ts") || arg.endsWith("api.cjs")),
    );
    expect(api?.join(" ")).not.toMatch(/docker|compose/);
  });
});

describe("local mode persistence and supervision", () => {
  it("reuses the port and password, and replaces a port that is in use", async () => {
    const root = await userData();
    const seen: EmbeddedPostgresOptions[] = [];
    const randomHex = vi.fn((bytes: number) => "ab".repeat(bytes));
    const first = new LocalModeController(
      harness(root, {
        randomHex,
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: (options) => {
          seen.push(options);
          return runningPostgres();
        },
      }),
    );
    await first.start();
    expect(seen[0]?.port).toBe(23456);
    expect(await readFile(path.join(root, "postgres.port"), "utf8")).toBe("23456\n");
    const mode = (await import("node:fs/promises")).stat;
    expect((await mode(path.join(root, "postgres.port"))).mode & 0o777).toBe(0o600);
    expect((await mode(path.join(root, "secrets.env"))).mode & 0o777).toBe(0o600);

    randomHex.mockClear();
    const second = new LocalModeController(
      harness(root, {
        randomHex,
        allocatePort: async () => 29999,
        portAvailable: async (port) => port !== 23456,
        postgresFactory: (options) => {
          seen.push(options);
          return runningPostgres();
        },
      }),
    );
    await second.start();
    expect(randomHex).not.toHaveBeenCalled();
    expect(seen[1]?.port).toBe(29999);
    expect(seen[1]?.password).toBe(seen[0]?.password);
    expect(await readFile(path.join(root, "postgres.port"), "utf8")).toBe("29999\n");
    expect(seen[1]?.port).not.toBe(5432);
  });

  it("stops the worker, then the API, then Postgres, and restarts a crashed child with backoff", async () => {
    const root = await userData();
    const order: string[] = [];
    const children: Array<ChildProcess & { stdout: EventEmitter; stderr: EventEmitter }> = [];
    const failed: string[] = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        spawn: (_command, args) => {
          const child = fakeChild();
          const service = args.some((arg) => arg.includes("worker")) ? "worker" : "api";
          child.kill = vi.fn((signal?: NodeJS.Signals) => {
            order.push(`${service}:${signal ?? "SIGTERM"}`);
            queueMicrotask(() => child.emit("exit", 0, signal));
            return true;
          });
          children.push(child);
          return child;
        },
        postgresFactory: () => ({
          initialise: async () => undefined,
          start: async () => undefined,
          stop: async () => {
            order.push("postgres");
          },
        }),
        onFailed: (message) => {
          failed.push(message);
        },
      }),
    );
    await controller.start();
    expect(children).toHaveLength(2);
    await controller.stop();
    expect(order).toEqual(["worker:SIGINT", "api:SIGINT", "postgres"]);

    const restarted = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23457,
        portAvailable: async () => true,
        spawn: () => {
          const child = fakeChild();
          children.push(child);
          return child;
        },
        onFailed: (message) => {
          failed.push(message);
        },
        postgresFactory: () => runningPostgres(),
      }),
    );
    children.length = 0;
    await restarted.start();
    vi.useFakeTimers();
    const worker = children.find((_, index) => index % 2 === 1) ?? children[1];
    expect(worker).toBeDefined();
    const before = children.length;
    worker!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(children).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(children.length).toBeGreaterThan(before);
    children.at(-1)!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(2000);
    children.at(-1)!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(4000);
    const running = children.length;
    children.at(-1)!.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(running);
    expect(failed.some((message) => message === "The worker stopped.")).toBe(true);
    const starts = children.length;
    restarted.reportDatabaseDown();
    expect(failed).toContain("The database stopped.");
    expect(children).toHaveLength(starts);
  });
});

describe("database credentials", () => {
  it("writes initdb's password file only to a private folder inside the app data folder", async () => {
    const root = await userData();
    const before = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    let during = "";
    let mode = 0;
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => ({
          ...runningPostgres(),
          initialise: async () => {
            // What the library resolves its password file against.
            during = tmpdir();
            mode = (await stat(during)).mode & 0o777;
          },
        }),
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(path.dirname(during)).toBe(root);
    expect(mode).toBe(0o700);
    await expect(stat(during)).rejects.toThrow();
    expect({ TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP }).toEqual(
      before,
    );
    await controller.stop();
  });

  it("gives migrations and the services the application role, never the superuser", async () => {
    const root = await userData();
    const migrations: { adminUrl: string; databaseUrl: string }[] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    let secret = 0;
    const controller = new LocalModeController(
      harness(root, {
        randomHex: (bytes) => (++secret).toString(16).padStart(bytes * 2, "0"),
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        migrate: async ({ adminUrl, databaseUrl }) => {
          migrations.push({ adminUrl, databaseUrl });
        },
        spawn: (_command, _args, options) => {
          envs.push(options.env ?? {});
          return fakeChild();
        },
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    const saved = await readFile(path.join(root, "secrets.env"), "utf8");
    const superuser = /^POSTGRES_PASSWORD=(.+)$/m.exec(saved)?.[1];
    const role = /^APP_DATABASE_PASSWORD=(.+)$/m.exec(saved)?.[1];
    expect(role).toMatch(/^[0-9a-f]{32}$/);
    expect(new URL(migrations[0]!.adminUrl)).toMatchObject({
      username: "ardurbot",
      password: superuser,
    });
    expect(new URL(migrations[0]!.databaseUrl)).toMatchObject({
      username: "ardurbot_app",
      password: role,
      pathname: "/ardurbot",
    });
    for (const env of envs) {
      expect(env.DATABASE_URL).toBe(migrations[0]!.databaseUrl);
      expect(env.DATABASE_URL).not.toContain(superuser);
    }
    await controller.stop();
  });
});

describe("stopping during a start", () => {
  it("cancels the migrations and waits for them before stopping the database", async () => {
    const root = await userData();
    const order: string[] = [];
    let migrating: () => void = () => undefined;
    const reachedMigrations = new Promise<void>((resolve) => {
      migrating = resolve;
    });
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => ({
          ...runningPostgres(),
          stop: async () => {
            order.push("database stopped");
          },
        }),
        migrate: ({ signal }) =>
          new Promise((_, reject) => {
            migrating();
            signal.addEventListener("abort", () => {
              // The migrator cancels its statement; the connection settles a moment later.
              setTimeout(() => {
                order.push("migrations settled");
                reject(new Error("canceling statement due to user request"));
              }, 50);
            });
          }),
      }),
    );
    const started = controller.start();
    await reachedMigrations;
    await within(2_000, controller.stop());
    expect(order).toEqual(["migrations settled", "database stopped"]);
    await started;
    expect(controller.state().phase).toBe("idle");
    expect(controller.running()).toBe(false);
  });

  it("starts fresh when start() follows stop() while the old run winds down", async () => {
    const root = await userData();
    let migrations = 0;
    let migrating: () => void = () => undefined;
    const reachedMigrations = new Promise<void>((resolve) => {
      migrating = resolve;
    });
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        migrate: ({ signal }) => {
          migrations += 1;
          if (migrations > 1) return Promise.resolve();
          migrating();
          return new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              setTimeout(() => reject(new Error("canceled")), 50);
            });
          });
        },
      }),
    );
    const first = controller.start();
    await reachedMigrations;
    const stopping = controller.stop();
    const second = controller.start();
    expect(second).not.toBe(first);
    expect(await within(2_000, second)).toMatchObject({ phase: "ready" });
    await stopping;
    expect(migrations).toBe(2);
    expect(controller.running()).toBe(true);
    await controller.stop();
  });

  it("does not start after a later stop, even when a start was waiting", async () => {
    const root = await userData();
    let migrations = 0;
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        migrate: async () => {
          migrations += 1;
        },
      }),
    );
    await controller.start();
    const stopping = controller.stop();
    const waiting = controller.start();
    await controller.stop();
    await stopping;
    expect(await waiting).toMatchObject({ phase: "idle" });
    expect(migrations).toBe(1);
    expect(controller.running()).toBe(false);
  });

  it("starts nothing while the app quits, and starts again after a cancelled quit", async () => {
    const root = await userData();
    let servers = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => {
          servers += 1;
          // The first server takes a while to stop; later ones stop at once.
          return { ...runningPostgres(), stop: () => (servers === 1 ? held : Promise.resolve()) };
        },
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    const quitting = controller.quit();
    // Retry in a failure sheet, or the setup window, while the stop winds down.
    const refused = controller.start();
    release();
    await quitting;
    await refused;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.state().phase).toBe("idle");
    expect(controller.running()).toBe(false);
    expect(servers).toBe(1);
    // The quit was cancelled (unsaved changes); the person starts local mode again.
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(servers).toBe(2);
    await within(2_000, controller.quit());
    expect(controller.running()).toBe(false);
  });

  it("ends a database start that is under way, so the stop settles", async () => {
    const root = await userData();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    let starting: () => void = () => undefined;
    const reachedStart = new Promise<void>((resolve) => {
      starting = resolve;
    });
    let rejectStart: (error: Error) => void = () => undefined;
    const postgres = {
      initialise: async () => undefined,
      process: child,
      // Like the library: the start settles only when the server is ready or has exited.
      start: () =>
        new Promise<void>((_, reject) => {
          rejectStart = reject;
          starting();
        }),
      stop: vi.fn(async () => {
        child.exitCode = 0;
        rejectStart(new Error("exited"));
      }),
    };
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => postgres,
      }),
    );
    const started = controller.start();
    await reachedStart;
    await within(2_000, controller.stop());
    expect(postgres.stop).toHaveBeenCalledOnce();
    await started;
    expect(controller.state().phase).toBe("idle");
  });
});

describe("database watch", () => {
  it("says the database stopped, with Retry, when its process exits after ready", async () => {
    const root = await userData();
    const failed: string[] = [];
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    let starts = 0;
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () =>
          Object.assign(runningPostgres(), {
            process: child,
            start: async () => {
              starts += 1;
            },
          }),
        onFailed: (message) => {
          failed.push(message);
        },
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    Object.assign(child, { exitCode: 1 });
    child.emit("exit", 1, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.state()).toMatchObject({ phase: "failed", message: "The database stopped." });
    expect(failed).toEqual(["The database stopped."]);
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(starts).toBe(2);
    await controller.stop();
  });

  it("says the database stopped once a server an earlier run left fails a third, longer check too", async () => {
    const root = await userData();
    const databaseDir = path.join(root, "postgres");
    await mkdir(databaseDir, { recursive: true });
    await writeFile(path.join(databaseDir, "postmaster.pid"), `4321\n${databaseDir}\n0\n23999\n`);
    // The first answer adopts the server; the rest are the checks after ready.
    const answers = [true];
    let checks = 0;
    const failedAt: number[] = [];
    const stopAdoptedPostgres = vi.fn(async () => undefined);
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        adoptedCheckMs: 10,
        stopAdoptedPostgres,
        postgresServes: async () => {
          checks += 1;
          return answers.shift() ?? false;
        },
        postgresFactory: () => {
          throw new Error("a second server must not start");
        },
        onFailed: (message) => {
          failedAt.push(checks);
          expect(message).toBe("The database stopped.");
        },
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(checks).toBe(1);
    // Two missed answers in a row still are not enough: a third, with a longer timeout,
    // decides for certain. Here it is also down, so the stack is reported.
    answers.push(false, true, false, false, false);
    await vi.waitFor(() => expect(controller.state().phase).toBe("failed"));
    expect(controller.state()).toMatchObject({ message: "The database stopped." });
    expect(failedAt).toEqual([6]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(failedAt).toEqual([6]);
    // Never pg_ctl stop a server this run did not start.
    expect(stopAdoptedPostgres).not.toHaveBeenCalled();
    await controller.stop();
  });

  it("keeps an adopted server running when it answers again on the third, longer check", async () => {
    const root = await userData();
    const databaseDir = path.join(root, "postgres");
    await mkdir(databaseDir, { recursive: true });
    await writeFile(path.join(databaseDir, "postmaster.pid"), `4321\n${databaseDir}\n0\n23999\n`);
    // Unlike the report case above, a server that answers once the queue is empty is
    // healthy indefinitely, so the watch never has cause to report it down.
    const answers = [true];
    let checks = 0;
    const failed: string[] = [];
    const stopAdoptedPostgres = vi.fn(async () => undefined);
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        adoptedCheckMs: 10,
        stopAdoptedPostgres,
        postgresServes: async () => {
          checks += 1;
          return answers.length > 0 ? answers.shift()! : true;
        },
        postgresFactory: () => {
          throw new Error("a second server must not start");
        },
        onFailed: (message) => failed.push(message),
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    // A heavy workload made the server miss two checks; the third, longer one catches it.
    answers.push(false, false, true);
    await vi.waitFor(() => expect(checks).toBeGreaterThanOrEqual(4));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(controller.state().phase).toBe("ready");
    expect(failed).toEqual([]);
    expect(stopAdoptedPostgres).not.toHaveBeenCalled();
    await controller.stop();
  });
});

describe("reset", () => {
  it("moves the database, files and settings aside, and the next start is fresh", async () => {
    const root = await userData();
    await mkdir(path.join(root, "postgres"), { recursive: true });
    await writeFile(path.join(root, "postgres", "PG_VERSION"), "16\n");
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "note.txt"), "kept aside");
    const initialised: number[] = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        now: () => Date.UTC(2026, 8, 25, 10, 30),
        postgresFactory: () => ({
          ...runningPostgres(),
          initialise: async () => {
            initialised.push(1);
          },
        }),
      }),
    );
    // No secrets.env over an existing database: only a reset clears it.
    expect(await controller.start()).toMatchObject({ phase: "failed", offerReset: true });
    const backup = await controller.resetData();
    expect(backup).toBe(path.join(root, "backups", "local-data-2026-09-25T10-30-00-000Z"));
    expect((await readdir(backup)).sort()).toEqual(["data", "postgres"]);
    expect(await readFile(path.join(backup, "data", "note.txt"), "utf8")).toBe("kept aside");
    expect(controller.state().phase).toBe("idle");
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(initialised).toHaveLength(1);
    expect(await readFile(path.join(root, "secrets.env"), "utf8")).toMatch(/^POSTGRES_PASSWORD=/m);
    await controller.stop();
  });

  const unmovable =
    process.platform === "win32"
      ? "Folder permissions do not stop a move on Windows."
      : process.getuid?.() === 0
        ? "Folder permissions do not stop root."
        : null;
  it.skipIf(unmovable !== null)(
    `moves nothing when one item cannot move, and a second reset uses one backup folder${unmovable ? ` (${unmovable})` : ""}`,
    async () => {
      const root = await userData();
      await mkdir(path.join(root, "postgres"), { recursive: true });
      await writeFile(path.join(root, "postgres", "PG_VERSION"), "16\n");
      await mkdir(path.join(root, "data"), { recursive: true });
      await writeFile(path.join(root, "data", "note.txt"), "kept");
      await writeFile(path.join(root, "secrets.env"), "POSTGRES_PASSWORD=a\n");
      let minute = 0;
      const controller = new LocalModeController(
        harness(root, {
          allocatePort: async () => 23456,
          portAvailable: async () => true,
          now: () => Date.UTC(2026, 8, 25, 10, minute++),
          postgresFactory: () => runningPostgres(),
        }),
      );
      // A folder that cannot leave its parent, as a folder a running program holds on Windows.
      await chmod(path.join(root, "data"), 0o500);
      let failure: unknown;
      try {
        await controller.resetData();
      } catch (error) {
        failure = error;
      } finally {
        await chmod(path.join(root, "data"), 0o700);
      }
      expect(failure).toBeDefined();
      expect(await readdir(root)).toEqual(
        expect.arrayContaining(["data", "postgres", "secrets.env"]),
      );
      expect(await readFile(path.join(root, "postgres", "PG_VERSION"), "utf8")).toBe("16\n");
      expect(await readdir(path.join(root, "backups"))).toEqual([]);
      // A folder the app cannot write to (EACCES) is a permissions problem, not a locked file.
      expect(localResetFailure(failure)).toBe(
        "Ardur Bot cannot move its local data. Check the permissions of its data folder, then try Reset local data again.",
      );

      const backup = await controller.resetData();
      expect(await readdir(path.join(root, "backups"))).toEqual([path.basename(backup)]);
      expect((await readdir(backup)).sort()).toEqual(["data", "postgres", "secrets.env"]);
      expect(await readFile(path.join(backup, "data", "note.txt"), "utf8")).toBe("kept");
    },
  );

  it.skipIf(process.platform === "win32")(
    "ends bot commands still running in the data folder before it moves anything",
    { timeout: 30_000 },
    async () => {
      const root = await userData();
      let command = 0;
      const worker = [
        'const { spawn } = require("node:child_process");',
        // Like a bot command: its own process group, working in the data folder.
        'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: process.env.DATA_DIR, detached: true, stdio: "ignore" });',
        'process.stdout.write("command " + child.pid + "\\n");',
        "process.on('SIGINT', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const controller = new LocalModeController(
        harness(root, {
          allocatePort: async () => 23456,
          portAvailable: async () => true,
          postgresFactory: () => runningPostgres(),
          spawn: (_command, args, options) => {
            if (!isWorker(args)) return fakeChild();
            const child = spawn(process.execPath, ["-e", worker], options);
            child.stdout?.on("data", (chunk: Buffer) => {
              const found = /command (\d+)/u.exec(chunk.toString());
              if (found) command = Number(found[1]);
            });
            return child;
          },
        }),
      );
      try {
        expect(await controller.start()).toMatchObject({ phase: "ready" });
        await vi.waitFor(() => expect(command).toBeGreaterThan(0));
        expect(alive(command)).toBe(true);
        await controller.resetData();
        await vi.waitFor(() => expect(alive(command)).toBe(false), { timeout: 5_000 });
      } finally {
        if (command && alive(command)) process.kill(command, "SIGKILL");
      }
    },
  );

  it("ends each service's process tree with taskkill on Windows before it moves anything", async () => {
    const root = await userData();
    const calls: string[][] = [];
    const services: FakeChild[] = [];
    const controller = new LocalModeController(
      harness(root, {
        platform: "win32",
        env: { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" },
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        spawn: (command, args) => {
          calls.push([command, ...args]);
          if (command.endsWith("taskkill.exe")) {
            const killer = fakeChild();
            const target = services.find((service) => String(service.pid) === args[1]);
            queueMicrotask(() => {
              target?.emit("exit", 1, null);
              killer.emit("exit", 0, null);
            });
            return killer;
          }
          const service = Object.assign(fakeChild(), { pid: 4000 + services.length });
          services.push(service);
          return service;
        },
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    await controller.resetData();
    const killed = calls.filter(([command]) => command!.endsWith("taskkill.exe"));
    // The worker first, then the API, as a stop orders them.
    expect(killed).toEqual(
      [...services]
        .reverse()
        .map((service) => [
          path.win32.join("C:\\Windows", "System32", "taskkill.exe"),
          "/pid",
          String(service.pid),
          "/t",
          "/f",
        ]),
    );
    for (const service of services) expect(service.kill).not.toHaveBeenCalled();
  });

  it("keeps offering the failure a reset was meant to clear after the reset itself fails", async () => {
    const root = await userData();
    await mkdir(path.join(root, "postgres"), { recursive: true });
    await writeFile(path.join(root, "postgres", "PG_VERSION"), "16\n");
    await mkdir(path.join(root, "data"), { recursive: true });
    const states: { phase: string; offerReset?: boolean }[] = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        onState: (state) => states.push(state),
      }),
    );
    // No secrets.env over an existing database: only a reset clears it.
    expect(await controller.start()).toMatchObject({ phase: "failed", offerReset: true });
    states.length = 0;

    await chmod(path.join(root, "data"), 0o500);
    try {
      await expect(controller.resetData()).rejects.toThrow();
    } finally {
      await chmod(path.join(root, "data"), 0o700);
    }

    // Stopping published idle, but the setup window and Settings must see the original
    // failure again, with its Reset button, not idle.
    expect(states.map((state) => state.phase)).toEqual(["idle", "failed"]);
    expect(controller.state()).toMatchObject({ phase: "failed", offerReset: true });
  });

  it("leaves the stack idle after a reset with no prior failure fails to move anything", async () => {
    const root = await userData();
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    await mkdir(path.join(root, "data"), { recursive: true });

    await chmod(path.join(root, "data"), 0o500);
    try {
      await expect(controller.resetData()).rejects.toThrow();
    } finally {
      await chmod(path.join(root, "data"), 0o700);
    }
    expect(controller.state().phase).toBe("idle");
  });
});

describe("reset failure sentences", () => {
  const errorWithCode = (code: string): NodeJS.ErrnoException =>
    Object.assign(new Error(code), { code });

  it("means a program still has the file open on EBUSY", () => {
    expect(resetMoveFailure(errorWithCode("EBUSY"), "darwin")).toBe(
      "A local data file is in use; close whatever is using it and try again.",
    );
  });

  it("means a program still has the file open on Windows EPERM", () => {
    expect(resetMoveFailure(errorWithCode("EPERM"), "win32")).toBe(
      "A local data file is in use; close whatever is using it and try again.",
    );
  });

  it("means the app cannot write to the folder on EACCES", () => {
    expect(resetMoveFailure(errorWithCode("EACCES"), "darwin")).toBe(
      "Ardur Bot cannot move its local data. Check the permissions of its data folder, then try Reset local data again.",
    );
  });

  it("means the app cannot write to the folder on EPERM off Windows", () => {
    expect(resetMoveFailure(errorWithCode("EPERM"), "linux")).toBe(
      "Ardur Bot cannot move its local data. Check the permissions of its data folder, then try Reset local data again.",
    );
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("packaged and unpackaged service launch", () => {
  it("starts packaged services from api.mjs and worker.mjs with the loader and NODE_PATH", async () => {
    const root = await userData();
    const spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const controller = new LocalModeController(
      harness(root, {
        packaged: true,
        resourcesPath: "/fixture/resources",
        execPath: "/fixture/electron",
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        spawn: (command, args, options) => {
          spawned.push({ command, args, env: options.env ?? {} });
          return fakeChild();
        },
      }),
    );
    const state = await controller.start();
    expect(state.phase).toBe("ready");
    const services = path.join("/fixture/resources", "services");
    const loader = path.join(services, "services-loader.mjs");
    for (const entry of ["api.mjs", "worker.mjs"]) {
      const child = spawned.find((item) => item.args.at(-1) === path.join(services, entry));
      expect(child?.command).toBe("/fixture/electron");
      expect(child?.args).toEqual(["--import", loader, path.join(services, entry)]);
      expect(child?.env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(child?.env.NODE_PATH).toBe(path.join(services, "modules"));
    }
  });

  it("keeps tsx for an unpackaged checkout", () => {
    const launch = localServiceLaunch({
      service: "worker",
      packaged: false,
      execPath: "/fixture/electron",
      resourcesPath: "/fixture/resources",
      appPath: "/fixture/desktop",
    });
    expect(launch.args[0]).toBe("--import");
    expect(launch.args[1]).toBe(
      path.join("/fixture/desktop", "../../node_modules/tsx/dist/loader.mjs"),
    );
    expect(launch.args[2]).toBe(path.join("/fixture/desktop", "..", "worker", "src", "index.ts"));
    expect(launch.nodePath).toBeUndefined();
  });
});

describe("database lifecycle", () => {
  it("stops Postgres when migration fails and clears the handle", async () => {
    const root = await userData();
    let stops = 0;
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        migrate: async () => {
          throw new Error("migration failed");
        },
        postgresFactory: () => ({
          initialise: async () => undefined,
          start: async () => undefined,
          stop: async () => {
            stops += 1;
          },
        }),
      }),
    );
    const state = await controller.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toBe("The database stopped.");
    expect(stops).toBe(1);
    await controller.stop();
    expect(stops).toBe(1);
  });

  it("uses a server a previous run left only after it proves it serves this folder", async () => {
    const root = await userData();
    const databaseDir = path.join(root, "postgres");
    await mkdir(databaseDir, { recursive: true });
    await writeFile(path.join(databaseDir, "postmaster.pid"), `4321\n${databaseDir}\n0\n23999\n`);
    let starts = 0;
    const stoppedAdopted: string[] = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresServes: async ({ port, databaseDir: dir }) => port === 23999 && dir === databaseDir,
        stopAdoptedPostgres: async (dir) => {
          stoppedAdopted.push(dir);
        },
        postgresFactory: () => ({
          initialise: async () => undefined,
          start: async () => {
            starts += 1;
          },
          stop: async () => undefined,
        }),
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(starts).toBe(0);
    expect(await readFile(path.join(root, "postgres.port"), "utf8")).toBe("23999\n");
    await controller.stop();
    expect(stoppedAdopted).toEqual([databaseDir]);
  });

  it("never signals a process that postmaster.pid names without proof", async () => {
    const root = await userData();
    const databaseDir = path.join(root, "postgres");
    await mkdir(databaseDir, { recursive: true });
    // After a restart the recorded pid can belong to any process of this user.
    const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      stdio: "ignore",
    });
    const closed = await closedLoopbackPort();
    await writeFile(
      path.join(databaseDir, "postmaster.pid"),
      `${unrelated.pid}\n${databaseDir}\n0\n${closed}\n`,
    );
    const kill = vi.spyOn(process, "kill");
    try {
      const controller = new LocalModeController(
        harness(root, {
          allocatePort: async () => 23456,
          portAvailable: async () => true,
          // The real check: nothing answers on the recorded port for this folder.
          postgresServes: postgresServesFolder,
          migrate: async () => {
            throw new Error("Connection terminated unexpectedly");
          },
          postgresFactory: () => runningPostgres(),
        }),
      );
      const state = await controller.start();
      await controller.stop();
      expect(kill.mock.calls.filter(([pid]) => pid === unrelated.pid)).toEqual([]);
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
      expect(state).toMatchObject({ phase: "failed", message: "The database stopped." });
    } finally {
      kill.mockRestore();
      unrelated.kill("SIGKILL");
    }
  });

  it("does not start Postgres when quit wins before start", async () => {
    const root = await userData();
    let starts = 0;
    let stops = 0;
    let stopping: Promise<void> | undefined;
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => {
          stopping = controller.stop();
          return {
            initialise: async () => undefined,
            start: async () => {
              starts += 1;
            },
            stop: async () => {
              stops += 1;
            },
          };
        },
      }),
    );
    await controller.start();
    await stopping;
    expect(starts).toBe(0);
    expect(stops).toBeGreaterThanOrEqual(1);
    expect(controller.running()).toBe(false);
  });

  it("says in plain words that the database could not be updated, logs the details, and Retry applies it once fixed", async () => {
    const root = await userData();
    const databaseDir = path.join(root, "postgres");
    let stops = 0;
    let broken = true;
    const migrations: string[] = [];
    const failed: string[] = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresServes: async () => true,
        migrate: async (url) => {
          migrations.push(url);
          if (broken) {
            throw new MigrationApplyError(
              "20260101000000_init",
              'relation "widgets" does not exist\nDETAIL: the table was dropped by hand',
            );
          }
        },
        postgresFactory: () => ({
          initialise: async () => undefined,
          // Postgres writes this file while it runs and removes it on a clean stop.
          start: () =>
            writeFile(path.join(databaseDir, "postmaster.pid"), `4321\n${databaseDir}\n0\n23456\n`),
          stop: async () => {
            stops += 1;
            await unlink(path.join(databaseDir, "postmaster.pid"));
          },
        }),
        onFailed: (message) => {
          failed.push(message);
        },
      }),
    );
    const sentence =
      "The database could not be updated. Retry, or install the latest version if it happens again.";
    expect(await controller.start()).toMatchObject({ phase: "failed", message: sentence });
    expect(failed).toEqual([sentence]);
    expect(stops).toBe(1);
    expect(controller.running()).toBe(false);
    await vi.waitFor(async () => {
      const log = await readFile(path.join(root, "logs", "local-mode.log"), "utf8");
      expect(log).toContain("20260101000000_init");
      expect(log).toContain('relation "widgets" does not exist');
    });

    broken = false;
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(migrations).toHaveLength(2);
    await controller.stop();
  });

  it.each([
    [
      "newer",
      "This data was last opened by a newer version of Ardur Bot. Install the latest version of Ardur Bot, then Retry.",
      undefined,
    ],
    [
      "modified",
      "This version of Ardur Bot does not match its database. Install the latest version of Ardur Bot, then Retry.",
      undefined,
    ],
    [
      "unfinished",
      "An earlier database update did not finish. Choose Reset local data, or restore the app data folder from a backup.",
      true,
    ],
  ] as const)(
    "says what to do about a %s migration history, and logs the details",
    async (reason, sentence, offerReset) => {
      const root = await userData();
      const failed: Array<[string, boolean]> = [];
      const controller = new LocalModeController(
        harness(root, {
          allocatePort: async () => 23456,
          portAvailable: async () => true,
          postgresServes: async () => true,
          postgresFactory: () => runningPostgres(),
          migrate: async () => {
            throw new MigrationHistoryError(`Migration "20260101000000_init" (${reason})`, reason);
          },
          onFailed: (message, offered) => {
            failed.push([message, offered]);
          },
        }),
      );
      const state = await controller.start();
      expect(state).toMatchObject({ phase: "failed", message: sentence });
      expect(state.offerReset).toBe(offerReset);
      expect(failed).toEqual([[sentence, offerReset === true]]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await readFile(path.join(root, "logs", "local-mode.log"), "utf8")).toContain(
        `Migration "20260101000000_init" (${reason})`,
      );
    },
  );

  it("says the database stopped when the server is gone after a migration error", async () => {
    const root = await userData();
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresServes: async () => false,
        migrate: async () => {
          throw new Error("Connection terminated unexpectedly");
        },
        postgresFactory: () => runningPostgres(),
      }),
    );
    expect(await controller.start()).toMatchObject({
      phase: "failed",
      message: "The database stopped.",
    });
  });

  it("says part of the installation is missing, logs which package, and quit is not held for a database", async () => {
    const root = await userData();
    const failed: string[] = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: async () => {
          throw new MissingDatabaseBinariesError("@embedded-postgres/linux-x64");
        },
        onFailed: (message) => {
          failed.push(message);
        },
      }),
    );
    const sentence = "Part of this installation is missing. Reinstall Ardur Bot.";
    expect(await controller.start()).toMatchObject({ phase: "failed", message: sentence });
    expect(failed).toEqual([sentence]);
    expect(controller.running()).toBe(false);
    await vi.waitFor(async () => {
      expect(await readFile(path.join(root, "logs", "local-mode.log"), "utf8")).toContain(
        "@embedded-postgres/linux-x64",
      );
    });
  });
});

describe("stopping", () => {
  it("does not wait on a database whose process already exited, at Retry or at quit", async () => {
    const root = await userData();
    // The library keeps the exited child after a failed start and would wait for its
    // `exit` event forever.
    const exited = Object.assign(new EventEmitter(), { exitCode: 1, signalCode: null });
    const stops: string[] = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () =>
          Object.assign(runningPostgres(), {
            process: exited,
            stop: () => {
              stops.push("library");
              return new Promise<void>(() => undefined);
            },
          }),
      }),
    );
    expect(await within(2_000, controller.start())).toMatchObject({ phase: "ready" });
    await within(2_000, controller.stop());
    expect(stops).toEqual([]);
    expect(controller.running()).toBe(false);
  });

  it("kills only the server process it spawned when a stop does not finish in ten seconds", async () => {
    const root = await userData();
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () =>
          Object.assign(runningPostgres(), {
            process: child,
            stop: () => new Promise<void>(() => undefined),
          }),
      }),
    );
    await controller.start();
    vi.useFakeTimers();
    let done = false;
    const stopping = controller.stop().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(done).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("signals the API and worker at once when the app exits without a normal quit", async () => {
    const root = await userData();
    const children: FakeChild[] = [];
    const controller = new LocalModeController(
      harness(root, {
        platform: "win32",
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        spawn: () => {
          const child = fakeChild();
          children.push(child);
          return child;
        },
      }),
    );
    await controller.start();
    controller.signalServicesNow();
    expect(children.map((child) => vi.mocked(child.kill).mock.calls)).toEqual([
      [["SIGTERM"]],
      [["SIGTERM"]],
    ]);
  });

  it("reports the stack idle once it has stopped", async () => {
    const root = await userData();
    const phases: string[] = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        onState: (state) => {
          phases.push(state.phase);
        },
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    await controller.stop();
    expect(controller.state().phase).toBe("idle");
    expect(phases.at(-1)).toBe("idle");
  });
});

describe("saved database settings", () => {
  async function cluster(root: string) {
    await mkdir(path.join(root, "postgres"), { recursive: true });
    await writeFile(path.join(root, "postgres", "PG_VERSION"), "16\n");
  }

  it("stops instead of generating new secrets over a database it cannot read the settings for", async () => {
    const root = await userData();
    await cluster(root);
    // Unreadable in a way that holds for every user, including root.
    await mkdir(path.join(root, "secrets.env"));
    const randomHex = vi.fn((bytes: number) => "ef".repeat(bytes));
    let factoryCalls = 0;
    const controller = new LocalModeController(
      harness(root, {
        randomHex,
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => {
          factoryCalls += 1;
          return runningPostgres();
        },
      }),
    );
    expect(await controller.start()).toMatchObject({
      phase: "failed",
      message: SETTINGS_MISSING,
      offerReset: true,
    });
    expect(randomHex).not.toHaveBeenCalled();
    expect(factoryCalls).toBe(0);
    expect((await stat(path.join(root, "secrets.env"))).isDirectory()).toBe(true);
  });

  it("does not write new secrets when the file is missing but the database exists", async () => {
    const root = await userData();
    await cluster(root);
    const failed: Array<[string, boolean]> = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        onFailed: (message, offerReset) => {
          failed.push([message, offerReset]);
        },
      }),
    );
    expect(await controller.start()).toMatchObject({
      phase: "failed",
      message: SETTINGS_MISSING,
      offerReset: true,
    });
    // The dialog on the app window offers the same Reset local data the sentence names.
    expect(failed).toEqual([[SETTINGS_MISSING, true]]);
    await expect(stat(path.join(root, "secrets.env"))).rejects.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)(
    "names unreadable settings without a raw code, and says to check permissions",
    async () => {
      const root = await userData();
      await cluster(root);
      await writeFile(path.join(root, "secrets.env"), "POSTGRES_PASSWORD=x\n", { mode: 0o600 });
      await chmod(path.join(root, "secrets.env"), 0o000);
      const controller = new LocalModeController(
        harness(root, {
          allocatePort: async () => 23456,
          portAvailable: async () => true,
          postgresFactory: () => runningPostgres(),
        }),
      );
      const state = await controller.start();
      await chmod(path.join(root, "secrets.env"), 0o600);
      expect(state).toMatchObject({
        phase: "failed",
        message:
          "The app could not read its database settings. Check the permissions of the app data folder, then Retry.",
      });
      expect(state.offerReset).toBeUndefined();
    },
  );

  it("keeps a saved password and adds only a missing newer secret", async () => {
    const root = await userData();
    await cluster(root);
    await writeFile(
      path.join(root, "secrets.env"),
      "POSTGRES_PASSWORD=saved-password\nENCRYPTION_KEY=saved-key\n",
      { mode: 0o600 },
    );
    const seen: EmbeddedPostgresOptions[] = [];
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: (options) => {
          seen.push(options);
          return runningPostgres();
        },
      }),
    );
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(seen[0]?.password).toBe("saved-password");
    const saved = await readFile(path.join(root, "secrets.env"), "utf8");
    expect(saved).toContain("ENCRYPTION_KEY=saved-key\n");
    expect(saved).toMatch(/^SANDBOX_SUPERVISOR_TOKEN=[0-9a-f]{64}$/m);
    await controller.stop();
  });
});

describe("failure sentences", () => {
  it("names a missing free port", async () => {
    const root = await userData();
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => false,
        postgresFactory: () => runningPostgres(),
      }),
    );
    expect(await controller.start()).toMatchObject({
      phase: "failed",
      message: "No free local port was found. Close other apps, then Retry.",
    });
  });

  it("names an app data folder that cannot be written", async () => {
    const root = await userData();
    await writeFile(path.join(root, "logs"), "a file where the folder belongs");
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
      }),
    );
    expect(await controller.start()).toMatchObject({
      phase: "failed",
      message:
        "The app data folder could not be written. Check its permissions and free disk space, then Retry.",
    });
  });

  it("names settings that cannot be saved", async () => {
    const root = await userData();
    await mkdir(path.join(root, "postgres.port", "occupied"), { recursive: true });
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
      }),
    );
    const state = await controller.start();
    expect(state.phase).toBe("failed");
    expect(state.message).toBe(
      "The app could not save its database settings. Check free disk space, then Retry.",
    );
  });

  it("names a database that could not start, and does not wait on it", async () => {
    const root = await userData();
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => ({
          ...runningPostgres(),
          start: async () => {
            throw new Error("postmaster exited");
          },
        }),
      }),
    );
    expect(await controller.start()).toMatchObject({
      phase: "failed",
      message: "The database could not start. Retry, or restart the computer if it happens again.",
    });
    expect(controller.running()).toBe(false);
  });

  it("treats a service that cannot be spawned like one that exited", async () => {
    const root = await userData();
    const failed: string[] = [];
    const controller = new LocalModeController(
      harness(root, {
        restartDelayMs: () => 0,
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        fetch: async () => {
          throw new Error("ECONNREFUSED");
        },
        spawn: (_command, args) => {
          const child = fakeChild();
          // Node reports EAGAIN or ENOENT with `error` and no `exit`.
          if (!isWorker(args)) {
            queueMicrotask(() => child.emit("error", new Error("spawn EAGAIN")));
          }
          return child;
        },
        onFailed: (message) => {
          failed.push(message);
        },
      }),
    );
    expect(await controller.start()).toMatchObject({
      phase: "failed",
      message: "The API stopped.",
    });
    expect(failed).toEqual(["The API stopped."]);
    await controller.stop();
  });
});

describe("service readiness", () => {
  it("is not ready while the worker has given up, and Retry gives it a fresh restart budget", async () => {
    const root = await userData();
    const failed: string[] = [];
    const states: string[] = [];
    // Each worker either dies as soon as it starts or reports ready.
    const workerFates: Array<"dies" | "ready"> = ["dies", "dies", "dies", "dies"];
    // Only a running API or database holds its port; only the API answers health checks.
    const listening = new Set<number>();
    let nextPort = 23456;
    let apiStarts = 0;
    const databases: Array<{ port: number; process: EventEmitter & { exitCode: number | null } }> =
      [];
    const controller = new LocalModeController(
      harness(root, {
        workerReady: false,
        restartDelayMs: () => 0,
        allocatePort: async () => nextPort++,
        portAvailable: async (port) => !listening.has(port),
        postgresFactory: (options) => {
          const database = {
            port: options.port,
            process: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }),
          };
          databases.push(database);
          return {
            process: database.process,
            initialise: async () => undefined,
            start: async () => {
              // A second server on a port the first still holds could not start.
              if (listening.has(options.port)) throw new Error("port in use");
              listening.add(options.port);
            },
            stop: async () => {
              listening.delete(options.port);
            },
          } as EmbeddedPostgresLike;
        },
        fetch: async (url) => {
          if (!listening.has(Number(new URL(url).port))) throw new Error("ECONNREFUSED");
          return healthResponse();
        },
        spawn: (_command, args, options) => {
          const child = fakeChild();
          if (isWorker(args)) {
            const fate = workerFates.shift() ?? "ready";
            queueMicrotask(() => {
              if (fate === "dies") child.emit("exit", 1);
              else child.stdout.emit("data", Buffer.from(`${WORKER_READY_LINE}\n`));
            });
          } else {
            apiStarts += 1;
            listening.add(Number(options.env?.API_PORT));
          }
          return child;
        },
        onState: (state) => {
          states.push(state.phase);
        },
        onFailed: (message) => {
          failed.push(message);
        },
      }),
    );
    const state = await controller.start();
    expect(state).toMatchObject({ phase: "failed", message: "The worker stopped." });
    expect(states).not.toContain("ready");
    expect(failed).toEqual(["The worker stopped."]);
    const origin = controller.origin();

    // Retry keeps the running API and database on their ports, and one early worker death
    // is restarted again instead of failing at once.
    workerFates.push("dies", "ready");
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(failed).toEqual(["The worker stopped."]);
    expect(apiStarts).toBe(1);
    expect(databases).toHaveLength(1);
    expect(controller.origin()).toBe(origin);
    expect(await readFile(path.join(root, "postgres.port"), "utf8")).toBe(
      `${databases[0]!.port}\n`,
    );

    // The same server is still watched after the Retry.
    Object.assign(databases[0]!.process, { exitCode: 1 });
    databases[0]!.process.emit("exit", 1, null);
    await vi.waitFor(() =>
      expect(controller.state()).toMatchObject({
        phase: "failed",
        message: "The database stopped.",
      }),
    );
    expect(failed).toEqual(["The worker stopped.", "The database stopped."]);
    await controller.stop();
  });

  it("waits for the worker's ready line even when it arrives split across chunks", async () => {
    const root = await userData();
    const workers: FakeChild[] = [];
    const controller = new LocalModeController(
      harness(root, {
        workerReady: false,
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => runningPostgres(),
        spawn: (_command, args) => {
          const child = fakeChild();
          if (isWorker(args)) workers.push(child);
          return child;
        },
      }),
    );
    let settled = false;
    const started = controller.start().finally(() => {
      settled = true;
    });
    while (workers.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(settled).toBe(false);
    workers[0]!.stdout.emit("data", Buffer.from('{"level":"info","message":"worker'));
    workers[0]!.stdout.emit("data", Buffer.from(' ready","service.name":"worker"}\n'));
    expect(await started).toMatchObject({ phase: "ready" });
    await controller.stop();
  });
});

describe("service logs", () => {
  it("keeps one rotated file once a log passes the cap", async () => {
    const root = await userData();
    const file = path.join(root, "api.log");
    expect(LOG_CAP_BYTES).toBe(10 * 1024 * 1024);
    await appendCappedLog(file, Buffer.from("01234567"), 8);
    await appendCappedLog(file, Buffer.from("abcdefgh"), 8);
    expect(await readFile(`${file}.1`, "utf8")).toBe("01234567");
    expect(await readFile(file, "utf8")).toBe("abcdefgh");
    await appendCappedLog(file, Buffer.from("zzzzzzzz"), 8);
    expect(await readFile(`${file}.1`, "utf8")).toBe("abcdefgh");
    await expect(readFile(`${file}.2`, "utf8")).rejects.toThrow();
  });
});

const SETTINGS_MISSING =
  "The app's database settings are missing. Choose Reset local data, or restore secrets.env from a backup.";

const WORKER_READY_LINE = '{"level":"info","message":"worker ready","service.name":"worker"}';

type FakeChild = ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };

function isWorker(args: string[]): boolean {
  return args.some((arg) => arg.includes("worker"));
}

/** Rejects if `promise` has not settled in time, so a hang fails fast instead of timing out. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    }),
  ]);
}

async function closedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

function runningPostgres(): EmbeddedPostgresLike {
  return {
    initialise: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
  };
}

/** Workers report ready unless `workerReady` is false. */
function harness(
  root: string,
  {
    workerReady = true,
    ...overrides
  }: Partial<ConstructorParameters<typeof LocalModeController>[0]> &
    Pick<
      ConstructorParameters<typeof LocalModeController>[0],
      "allocatePort" | "portAvailable" | "postgresFactory"
    > & { workerReady?: boolean },
): ConstructorParameters<typeof LocalModeController>[0] {
  const spawn = overrides.spawn ?? (() => fakeChild());
  return {
    userDataDir: root,
    packaged: false,
    resourcesPath: "/fixture/resources",
    appPath: "/fixture/desktop",
    execPath: "/fixture/electron",
    platform: "darwin",
    env: {
      PATH: "/usr/bin",
      ARDURBOT_HOST_BRIDGE: "api",
      DATABASE_URL: "postgres://keep@127.0.0.1:5433/ardurbot",
    },
    fetch: async () => healthResponse(),
    migrate: async () => undefined,
    stopAdoptedPostgres: async () => undefined,
    postgresServes: async () => false,
    randomHex: (bytes) => "cd".repeat(bytes),
    now: () => Date.now(),
    ...overrides,
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      if (workerReady && isWorker(args)) {
        queueMicrotask(() => {
          child.stdout?.emit("data", Buffer.from(`${WORKER_READY_LINE}\n`));
        });
      }
      return child;
    },
  };
}
