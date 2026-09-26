import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MigrationApplyError } from "@ardurbot/db/migrate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendCappedLog, LOG_CAP_BYTES } from "./local-logs.js";
import { LocalModeController, launchDesktopServices, localServiceLaunch } from "./local-mode.js";
import type { EmbeddedPostgresLike, EmbeddedPostgresOptions } from "./local-postgres.js";
import { MissingDatabaseBinariesError } from "./local-postgres.js";

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
    const opened: string[] = [];
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
        openApp: async (url) => {
          opened.push(url);
          return true;
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
    expect(opened).toEqual([`http://127.0.0.1:${port}`]);
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
      expect(env.ARDURBOT_HOST_ROOTS_FILE).toBe(path.join(root, "host-service", "host-roots.json"));
      expect(env.LOG_FORMAT).toBe("json");
    }
    expect(port).not.toBe(5432);
    expect(port).not.toBe(5433);
    const api = spawned.find((args) =>
      args.some((arg) => arg.endsWith("index.ts") || arg.endsWith("api.cjs")),
    );
    expect(api?.join(" ")).not.toMatch(/docker|compose/);
  });

  it("keeps the Compose controller when stack/.env exists and does not create postgres/", async () => {
    const root = await userData();
    await mkdir(path.join(root, "stack"), { recursive: true });
    await writeFile(path.join(root, "stack", ".env"), "POSTGRES_PASSWORD=fixture\n");
    const compose = vi.fn(async () => "compose");
    const local = vi.fn(async () => "local");
    const kind = await launchDesktopServices({
      userDataDir: root,
      local: { start: local },
      compose: { start: compose },
    });
    expect(kind).toBe("compose");
    expect(compose).toHaveBeenCalledOnce();
    expect(local).not.toHaveBeenCalled();
    await expect(readFile(path.join(root, "postgres", "PG_VERSION"), "utf8")).rejects.toThrow();
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

  it("retries by attaching to a healthy postmaster instead of starting another", async () => {
    const root = await userData();
    const databaseDir = path.join(root, "postgres");
    await mkdir(databaseDir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(databaseDir, "postmaster.pid"),
      `4321\n${databaseDir}\n0\n23456\n/tmp\n`,
    );
    let starts = 0;
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postmasterAlive: () => true,
        stopPostmaster: async () => undefined,
        postgresFactory: () => ({
          initialise: async () => undefined,
          start: async () => {
            starts += 1;
          },
          stop: async () => undefined,
        }),
      }),
    );
    const state = await controller.start();
    expect(state.phase).toBe("ready");
    expect(starts).toBe(0);
  });

  it("does not start Postgres when quit wins before start", async () => {
    const root = await userData();
    let starts = 0;
    let stops = 0;
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: () => {
          void controller.stop();
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
    expect(starts).toBe(0);
    expect(stops).toBeGreaterThanOrEqual(1);
    expect(controller.running()).toBe(false);
  });

  it("names the migration and the database error, and Retry applies it once fixed", async () => {
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
        postmasterAlive: () => true,
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
      'Preparing the database failed at 20260101000000_init: relation "widgets" does not exist.';
    expect(await controller.start()).toMatchObject({ phase: "failed", message: sentence });
    expect(failed).toEqual([sentence]);
    expect(stops).toBe(1);
    expect(controller.running()).toBe(false);

    broken = false;
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(migrations).toHaveLength(2);
    await controller.stop();
  });

  it("says the database stopped when the server is gone after a migration error", async () => {
    const root = await userData();
    const controller = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postmasterAlive: () => false,
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

  it("names missing database binaries, and quit is not held for a database", async () => {
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
    const sentence = "The database binaries @embedded-postgres/linux-x64 are missing.";
    expect(await controller.start()).toMatchObject({ phase: "failed", message: sentence });
    expect(failed).toEqual([sentence]);
    expect(controller.running()).toBe(false);
  });

  it("starts Compose without loading the database binaries when stack/.env exists", async () => {
    const root = await userData();
    await mkdir(path.join(root, "stack"), { recursive: true });
    await writeFile(path.join(root, "stack", ".env"), "POSTGRES_PASSWORD=fixture\n");
    const load = vi.fn(async () => {
      throw new MissingDatabaseBinariesError("@embedded-postgres/linux-x64");
    });
    const local = new LocalModeController(
      harness(root, {
        allocatePort: async () => 23456,
        portAvailable: async () => true,
        postgresFactory: load,
      }),
    );
    const compose = vi.fn(async () => undefined);
    expect(
      await launchDesktopServices({ userDataDir: root, local, compose: { start: compose } }),
    ).toBe("compose");
    expect(compose).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("service readiness", () => {
  it("is not ready while the worker has given up, and Retry gives it a fresh restart budget", async () => {
    const root = await userData();
    const failed: string[] = [];
    const states: string[] = [];
    // Each worker either dies as soon as it starts or reports ready.
    const workerFates: Array<"dies" | "ready"> = ["dies", "dies", "dies", "dies"];
    // Only a running API holds its port and answers on it.
    const listening = new Set<number>();
    let nextPort = 23456;
    let apiStarts = 0;
    const controller = new LocalModeController(
      harness(root, {
        workerReady: false,
        restartDelayMs: () => 0,
        allocatePort: async () => nextPort++,
        portAvailable: async (port) => !listening.has(port),
        postgresFactory: () => runningPostgres(),
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

    // Retry keeps the running API on its port, and one early worker death is restarted
    // again instead of failing at once.
    workerFates.push("dies", "ready");
    expect(await controller.start()).toMatchObject({ phase: "ready" });
    expect(failed).toEqual(["The worker stopped."]);
    expect(apiStarts).toBe(1);
    expect(controller.origin()).toBe(origin);
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

const WORKER_READY_LINE = '{"level":"info","message":"worker ready","service.name":"worker"}';

type FakeChild = ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };

function isWorker(args: string[]): boolean {
  return args.some((arg) => arg.includes("worker"));
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
    openApp: async () => true,
    migrate: async () => undefined,
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
