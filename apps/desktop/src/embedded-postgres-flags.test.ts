import { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { EMBEDDED_POSTGRES_FLAGS } from "./local-postgres.js";

const FAKE_PID = 424242;

type SpawnOptions = { file?: string; args?: string[] };

/**
 * The library keeps Node's own `spawn` function. Replacing that export does not
 * change the binding. Every spawn calls `ChildProcess.prototype.spawn`, so this
 * hook records the arguments and does not start a process.
 */
function installSpawnHook(spawned: { command: string; args: string[] }[]): {
  hooked: () => boolean;
  restore: () => void;
} {
  const prototype = ChildProcess.prototype as unknown as {
    spawn: (options: SpawnOptions) => void;
  };
  const original = prototype.spawn;
  let hooked = false;
  prototype.spawn = function spawnHook(this: ChildProcess, options: SpawnOptions) {
    hooked = true;
    const command = String(options.file ?? "");
    const args = Array.isArray(options.args) ? options.args.map(String) : [];
    spawned.push({ command, args });
    const child = this as ChildProcess & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: EventEmitter;
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    child.pid = FAKE_PID;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.kill = (signal?: NodeJS.Signals) => {
      child.emit("exit", 0, signal ?? null);
      return true;
    };
    const bin = path.basename(command);
    if (bin === "initdb") queueMicrotask(() => child.emit("close", 0, null));
    else if (bin === "postgres") {
      queueMicrotask(() => {
        child.stderr.emit("data", Buffer.from("database system is ready to accept connections\n"));
      });
    }
  };
  return {
    hooked: () => hooked,
    restore: () => {
      prototype.spawn = original;
    },
  };
}

it("passes listen and socket flags to the embedded server", async () => {
  const spawned: { command: string; args: string[] }[] = [];
  const hook = installSpawnHook(spawned);
  let databaseDir: string | undefined;
  let server: { stop: () => Promise<void> } | undefined;
  try {
    const probe = spawn(process.execPath, ["-e", "process.exit(0)"]);
    if (!hook.hooked() || probe.pid !== FAKE_PID) {
      throw new Error("Refusing to start the embedded server because the spawn hook missed.");
    }
    spawned.length = 0;

    databaseDir = await mkdtemp(path.join(tmpdir(), "ardurbot-flag-pin-"));
    const password = "fake-socket-marker";
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    server = new EmbeddedPostgres({
      databaseDir,
      port: 23456,
      user: "ardurbot",
      password,
      persistent: true,
      authMethod: "scram-sha-256",
      postgresFlags: [...EMBEDDED_POSTGRES_FLAGS],
      onLog: () => undefined,
      onError: () => undefined,
    });
    await server.initialise();
    await server.start();

    expect([...EMBEDDED_POSTGRES_FLAGS]).toEqual([
      "-c",
      "listen_addresses=127.0.0.1",
      "-c",
      "unix_socket_directories=",
    ]);
    const initdb = spawned.find((call) => path.basename(call.command) === "initdb");
    const postgres = spawned.find((call) => path.basename(call.command) === "postgres");
    expect(initdb?.args).toEqual(
      expect.arrayContaining([`--pgdata=${databaseDir}`, "--auth=scram-sha-256"]),
    );
    expect(initdb?.args.some((arg) => arg.startsWith("--pwfile="))).toBe(true);
    expect(postgres?.args.slice(1)).toEqual([
      "-D",
      databaseDir,
      "-p",
      "23456",
      ...EMBEDDED_POSTGRES_FLAGS,
    ]);
    for (const call of spawned) expect(call.args.join("\0")).not.toContain(password);
  } finally {
    hook.restore();
    if (server) await server.stop();
    if (databaseDir) await rm(databaseDir, { recursive: true, force: true });
  }
});
