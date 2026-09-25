import type * as Fs from "node:fs/promises";
import { access, mkdtemp, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const trial = vi.hoisted(() => ({
  directory: "",
  provider: vi.fn(async () => {}),
  tools: vi.fn(async () => {}),
  database: vi.fn(async () => {}),
  postgres: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof Fs>();
  return {
    ...fs,
    mkdtemp: async (prefix: string) => {
      const directory = await fs.mkdtemp(prefix);
      if (prefix.includes("scoreboard-replay-")) trial.directory = directory;
      return directory;
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      if (String(args[0]).endsWith("task-01.json"))
        throw new Error("synthetic report write failed");
      return fs.writeFile(...args);
    },
  };
});
vi.mock("../scoreboard/replay/postgres.js", () => ({
  provisionReplayPostgres: async () => ({
    fresh: async () => ({
      url: "postgresql://fixture:fixture@127.0.0.1:5432/scoreboard_trial_1",
      close: trial.database,
    }),
    close: trial.postgres,
  }),
}));
vi.mock("../scoreboard/replay/production.js", () => ({
  FIXTURE_ENCRYPTION_KEY: "synthetic-key",
  runProductionTask: async () => ({ taskId: "task-01", grade: { passed: true } }),
}));
vi.mock("../scoreboard/replay/services.js", () => ({
  DepartmentSandbox: class {},
  DepartmentServices: class {
    async transport() {
      return trial.tools;
    }
  },
}));
vi.mock("../scoreboard/replay/http.js", () => ({
  startReplayHttp: async () => ({
    baseUrl: "http://127.0.0.1:1",
    close: trial.provider,
    assertComplete() {},
    replay: { requests: [], sha256: "fixture" },
  }),
}));
vi.mock("../scoreboard/replay/recording.js", () => ({ startReferenceRecording: vi.fn() }));
vi.mock("../../../../apps/api/src/app.js", () => ({ createApp: vi.fn() }));
vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

const environment = { ...process.env };
const argv = process.argv;
const exitCode = process.exitCode;
const connect = Socket.prototype.connect;
let output: string;
afterEach(async () => {
  process.env = { ...environment };
  process.argv = argv;
  process.exitCode = exitCode;
  Socket.prototype.connect = connect;
  vi.restoreAllMocks();
  if (trial.directory) await rm(trial.directory, { recursive: true, force: true });
  if (output) await rm(output, { recursive: true, force: true });
});

it("cleans the trial after per-task report persistence fails and retains the write failure", async () => {
  output = await mkdtemp(path.join(tmpdir(), "scoreboard-report-test-"));
  process.argv = [
    process.execPath,
    "scoreboard-replay.ts",
    "--tier=T1",
    "--task=task-01",
    `--output=${output}`,
  ];
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./scoreboard-replay.js");
  await vi.waitFor(() => expect(error).toHaveBeenCalledWith("synthetic report write failed"));
  expect(process.exitCode).toBe(2);
  expect(trial.postgres).toHaveBeenCalledOnce();
  expect(trial.provider).toHaveBeenCalledOnce();
  expect(trial.tools).toHaveBeenCalledOnce();
  expect(trial.database).toHaveBeenCalledOnce();
  expect(Socket.prototype.connect).toBe(connect);
  expect(process.env.HOME).toBe(environment.HOME);
  expect(trial.directory).not.toBe("");
  await expect(access(trial.directory)).rejects.toMatchObject({ code: "ENOENT" });
});
