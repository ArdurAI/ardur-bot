import type { ChildProcess } from "node:child_process";
import EventEmitter from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  EmbeddedPostgresLike,
  EmbeddedPostgresOptions,
} from "../apps/desktop/src/local-postgres.js";
import { runDev } from "./dev.js";

class MockChildProcess extends EventEmitter {
  pid = 99999;
  killed = false;
  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }
}

describe("scripts/dev.ts", () => {
  it("default path spawns turbo with the exact old arguments and never calls a Postgres helper", async () => {
    let mockChild: MockChildProcess;
    const fakeSpawn = vi.fn().mockImplementation(() => {
      mockChild = new MockChildProcess();
      return mockChild as unknown as ChildProcess;
    });

    const fakeLoadPostgres = vi.fn();
    const fakeAllocatePort = vi.fn();
    const fakePostgresServes = vi.fn();
    const fakeInitialisePrivately = vi.fn();
    const fakeEnsureDatabase = vi.fn();
    const fakeStopOwnedPostgres = vi.fn();
    const fakeWritePersistedPort = vi.fn();

    await runDev({
      env: {},
      spawn: fakeSpawn,
      loadPostgres: fakeLoadPostgres,
      allocatePort: fakeAllocatePort,
      postgresServesFolder: fakePostgresServes,
      initialisePrivately: fakeInitialisePrivately,
      ensureDatabase: fakeEnsureDatabase,
      stopOwnedPostgres: fakeStopOwnedPostgres,
      writePersistedPort: fakeWritePersistedPort,
      exitOnChildExit: false,
    });

    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = fakeSpawn.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];

    expect(command).toBe("pnpm");
    expect(args).toEqual([
      "exec",
      "turbo",
      "dev",
      "--filter=@ardurbot/api",
      "--filter=@ardurbot/worker",
      "--filter=@ardurbot/web",
      "--filter=@ardurbot/sandbox-supervisor",
      "--filter=@ardurbot/host-service",
    ]);
    expect(options.env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe("0");
    expect(options.env.DATABASE_URL).toBeUndefined();
    expect(options.env.REALTIME_DATABASE_URL).toBeUndefined();

    // Must touch no Postgres code / call no Postgres helper
    expect(fakeLoadPostgres).not.toHaveBeenCalled();
    expect(fakeAllocatePort).not.toHaveBeenCalled();
    expect(fakePostgresServes).not.toHaveBeenCalled();
    expect(fakeInitialisePrivately).not.toHaveBeenCalled();
    expect(fakeEnsureDatabase).not.toHaveBeenCalled();
    expect(fakeStopOwnedPostgres).not.toHaveBeenCalled();
    expect(fakeWritePersistedPort).not.toHaveBeenCalled();
  });

  it("embedded path never chooses 5433, passes the chosen port in the children's DATABASE_URL, and stops the server when the child exits", async () => {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-test-"));
    try {
      let mockChild: MockChildProcess;
      const fakeSpawn = vi.fn().mockImplementation(() => {
        mockChild = new MockChildProcess();
        return mockChild as unknown as ChildProcess;
      });

      const fakeStart = vi.fn().mockResolvedValue(undefined);
      const fakeStop = vi.fn().mockResolvedValue(undefined);
      class FakeEmbeddedPostgres implements EmbeddedPostgresLike {
        constructor(readonly options: EmbeddedPostgresOptions) {}
        start = fakeStart;
        stop = fakeStop;
        initialise = vi.fn().mockResolvedValue(undefined);
      }

      const fakeLoadPostgres = vi.fn().mockResolvedValue({
        EmbeddedPostgres: FakeEmbeddedPostgres,
      });

      // Simulate allocator offering 5433 first, which must be rejected, then 5434
      const fakeAllocatePort = vi.fn().mockResolvedValueOnce(5433).mockResolvedValueOnce(5434);
      const fakePostgresServes = vi.fn().mockResolvedValue(false);
      const fakeInitialisePrivately = vi.fn().mockResolvedValue(undefined);
      const fakeEnsureDatabase = vi.fn().mockResolvedValue(undefined);
      const fakeStopOwnedPostgres = vi.fn().mockResolvedValue(undefined);
      const fakeWritePersistedPort = vi.fn().mockResolvedValue(undefined);

      await runDev({
        env: { ARDURBOT_DEV_POSTGRES: "embedded" },
        rootDir: testRoot,
        spawn: fakeSpawn,
        loadPostgres: fakeLoadPostgres,
        allocatePort: fakeAllocatePort,
        postgresServesFolder: fakePostgresServes,
        initialisePrivately: fakeInitialisePrivately,
        ensureDatabase: fakeEnsureDatabase,
        stopOwnedPostgres: fakeStopOwnedPostgres,
        writePersistedPort: fakeWritePersistedPort,
        exitOnChildExit: false,
      });

      expect(fakeSpawn).toHaveBeenCalledTimes(1);
      const [command, args, options] = fakeSpawn.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];

      expect(command).toBe("pnpm");
      expect(args).toEqual([
        "exec",
        "turbo",
        "dev",
        "--filter=@ardurbot/api",
        "--filter=@ardurbot/worker",
        "--filter=@ardurbot/web",
        "--filter=@ardurbot/sandbox-supervisor",
        "--filter=@ardurbot/host-service",
      ]);

      // Must never choose 5433
      expect(options.env.DATABASE_URL).toContain("127.0.0.1:5434");
      expect(options.env.DATABASE_URL).not.toContain("5433");
      expect(options.env.REALTIME_DATABASE_URL).toBe(options.env.DATABASE_URL);

      // Uses two different generated passwords for admin and app role
      expect(fakeEnsureDatabase).toHaveBeenCalledWith(
        expect.objectContaining({
          adminUrl: expect.stringContaining("127.0.0.1:5434"),
          databaseUrl: expect.stringContaining("127.0.0.1:5434"),
        }),
      );
      const ensureCall = fakeEnsureDatabase.mock.calls[0][0] as {
        adminUrl: string;
        databaseUrl: string;
      };
      const adminPass = new URL(ensureCall.adminUrl).password;
      const appPass = new URL(ensureCall.databaseUrl).password;
      expect(adminPass).toBeTruthy();
      expect(appPass).toBeTruthy();
      expect(adminPass).not.toBe(appPass);

      // Stored in a 0600 file inside .ardur/dev-postgres/
      const credFile = path.join(testRoot, ".ardur", "dev-postgres", "credentials.json");
      const credStat = await fs.stat(credFile);
      if (process.platform !== "win32") {
        expect(credStat.mode & 0o777).toBe(0o600);
      }
      const saved = JSON.parse(await fs.readFile(credFile, "utf8")) as {
        adminPassword?: string;
        appPassword?: string;
      };
      expect(saved.adminPassword).toBe(adminPass);
      expect(saved.appPassword).toBe(appPass);

      // Reused on the next start
      fakeAllocatePort.mockResolvedValueOnce(5436);
      await runDev({
        env: { ARDURBOT_DEV_POSTGRES: "embedded" },
        rootDir: testRoot,
        spawn: fakeSpawn,
        loadPostgres: fakeLoadPostgres,
        allocatePort: fakeAllocatePort,
        postgresServesFolder: fakePostgresServes,
        initialisePrivately: fakeInitialisePrivately,
        ensureDatabase: fakeEnsureDatabase,
        stopOwnedPostgres: fakeStopOwnedPostgres,
        writePersistedPort: fakeWritePersistedPort,
        exitOnChildExit: false,
      });
      const secondCall = fakeEnsureDatabase.mock.calls[1][0] as {
        adminUrl: string;
        databaseUrl: string;
      };
      expect(new URL(secondCall.adminUrl).password).toBe(adminPass);
      expect(new URL(secondCall.databaseUrl).password).toBe(appPass);

      // Server must be stopped when child process exits
      expect(fakeStopOwnedPostgres).not.toHaveBeenCalled();
      mockChild!.emit("exit", 0);
      await new Promise((r) => setTimeout(r, 20));
      expect(fakeStopOwnedPostgres).toHaveBeenCalledTimes(1);
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });

  it("embedded path never chooses 5433 even if ARDURBOT_DEV_POSTGRES_PORT is set to 5433", async () => {
    const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dev-test-port-"));
    try {
      let mockChild: MockChildProcess;
      const fakeSpawn = vi.fn().mockImplementation(() => {
        mockChild = new MockChildProcess();
        return mockChild as unknown as ChildProcess;
      });

      const fakeStart = vi.fn().mockResolvedValue(undefined);
      const fakeStop = vi.fn().mockResolvedValue(undefined);
      class FakeEmbeddedPostgres implements EmbeddedPostgresLike {
        constructor(readonly options: EmbeddedPostgresOptions) {}
        start = fakeStart;
        stop = fakeStop;
        initialise = vi.fn().mockResolvedValue(undefined);
      }

      const fakeLoadPostgres = vi.fn().mockResolvedValue({
        EmbeddedPostgres: FakeEmbeddedPostgres,
      });

      const fakeAllocatePort = vi.fn().mockResolvedValue(5435);
      const fakePostgresServes = vi.fn().mockResolvedValue(false);
      const fakeInitialisePrivately = vi.fn().mockResolvedValue(undefined);
      const fakeEnsureDatabase = vi.fn().mockResolvedValue(undefined);
      const fakeStopOwnedPostgres = vi.fn().mockResolvedValue(undefined);
      const fakeWritePersistedPort = vi.fn().mockResolvedValue(undefined);

      await runDev({
        env: {
          ARDURBOT_DEV_POSTGRES: "embedded",
          ARDURBOT_DEV_POSTGRES_PORT: "5433",
        },
        rootDir: testRoot,
        spawn: fakeSpawn,
        loadPostgres: fakeLoadPostgres,
        allocatePort: fakeAllocatePort,
        postgresServesFolder: fakePostgresServes,
        initialisePrivately: fakeInitialisePrivately,
        ensureDatabase: fakeEnsureDatabase,
        stopOwnedPostgres: fakeStopOwnedPostgres,
        writePersistedPort: fakeWritePersistedPort,
        exitOnChildExit: false,
      });

      expect(fakeSpawn).toHaveBeenCalledTimes(1);
      const [, , options] = fakeSpawn.mock.calls[0] as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];

      expect(options.env.DATABASE_URL).toContain("127.0.0.1:5435");
      expect(options.env.DATABASE_URL).not.toContain("5433");
      expect(options.env.REALTIME_DATABASE_URL).toBe(options.env.DATABASE_URL);
    } finally {
      await fs.rm(testRoot, { recursive: true, force: true });
    }
  });
});
