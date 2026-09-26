import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectStorageUsage } from "./storage-usage.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function userData(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "storage-usage-"));
  directories.push(dir);
  return dir;
}

function baseDeps(userDataDir: string, run = vi.fn()) {
  return {
    userDataDir,
    platform: "darwin",
    env: {},
    exists: existsSync,
    run,
    cacheSession: {
      getCacheSize: vi.fn(async () => 1_000),
      getStoragePath: () => null,
    },
  };
}

describe("collectStorageUsage", () => {
  it("reports the fixed rows, in bytes, from an empty install", async () => {
    const userDataDir = await userData();
    const rows = await collectStorageUsage(baseDeps(userDataDir));
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([
      "database",
      "computerHomes",
      "checkpoints",
      "artifacts",
      "boards",
      "appCache",
    ]);
    for (const r of rows) {
      expect(r.bytes).toBeGreaterThanOrEqual(0);
      expect(r.paths.length).toBeGreaterThan(0);
      for (const p of r.paths) expect(path.isAbsolute(p)).toBe(true);
    }
  });

  it("sums a bot's home directory into computer homes", async () => {
    const userDataDir = await userData();
    const homeDir = path.join(userDataDir, "data", "homes", "bot-1");
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(homeDir, "file.txt"), "12345");
    const rows = await collectStorageUsage(baseDeps(userDataDir));
    const computerHomes = rows.find((r) => r.id === "computerHomes")!;
    expect(computerHomes.bytes).toBe(5);
  });

  it("omits the sessions row when pi-sessions does not exist", async () => {
    const userDataDir = await userData();
    const rows = await collectStorageUsage(baseDeps(userDataDir));
    expect(rows.some((r) => r.id === "sessions")).toBe(false);
  });

  it("includes the sessions row once pi-sessions exists", async () => {
    const userDataDir = await userData();
    await mkdir(path.join(userDataDir, "data", "pi-sessions"), { recursive: true });
    const rows = await collectStorageUsage(baseDeps(userDataDir));
    expect(rows.some((r) => r.id === "sessions")).toBe(true);
  });

  it("omits the previous Docker data row when there is no stack directory", async () => {
    const userDataDir = await userData();
    const rows = await collectStorageUsage(baseDeps(userDataDir));
    expect(rows.some((r) => r.id === "previousDockerData")).toBe(false);
  });

  it("marks previous Docker data unavailable when no docker binary can be resolved", async () => {
    const userDataDir = await userData();
    const stackPath = path.join(userDataDir, "stack");
    await mkdir(stackPath, { recursive: true });
    await writeFile(path.join(stackPath, ".env"), "x=1");
    // Never resolves, whatever docker binaries happen to be installed on the host running
    // this test: only the stack directory itself is reported as existing.
    const deps = { ...baseDeps(userDataDir), exists: (file: string) => file === stackPath };
    const rows = await collectStorageUsage(deps);
    const docker = rows.find((r) => r.id === "previousDockerData")!;
    expect(docker).toBeDefined();
    expect(docker.dockerUnavailable).toBe(true);
    expect(docker.bytes).toBeGreaterThan(0);
  });

  it("combines the stack directory with the two named volumes when Docker answers", async () => {
    const userDataDir = await userData();
    const stackPath = path.join(userDataDir, "stack");
    await mkdir(stackPath, { recursive: true });
    // A binary path unique to this test run, so resolution never depends on what is
    // actually installed on the host running this test.
    const dockerBinary = path.join(userDataDir, "docker");
    const run = vi.fn(async () => ({
      code: 0,
      stdout: JSON.stringify({
        Volumes: [
          { Name: "ardurbot-desktop_pgdata", Size: "1MB" },
          { Name: "ardurbot-desktop_appdata", Size: "2MB" },
          { Name: "unrelated_volume", Size: "999MB" },
        ],
      }),
      stderr: "",
    }));
    const exists = (file: string) => file === stackPath || file === dockerBinary;
    const rows = await collectStorageUsage({
      ...baseDeps(userDataDir, run),
      env: { PATH: userDataDir },
      exists,
    });
    const docker = rows.find((r) => r.id === "previousDockerData")!;
    expect(docker.dockerUnavailable).toBe(false);
    expect(docker.bytes).toBe(3_000_000);
  });

  it("adds the HTTP cache size and the code cache directory size into App cache", async () => {
    const userDataDir = await userData();
    const codeCacheDir = path.join(userDataDir, "Code Cache");
    await mkdir(codeCacheDir, { recursive: true });
    await writeFile(path.join(codeCacheDir, "blob"), "1234567890");
    const deps = baseDeps(userDataDir);
    deps.cacheSession.getCacheSize = vi.fn(async () => 500);
    const rows = await collectStorageUsage(deps);
    const appCache = rows.find((r) => r.id === "appCache")!;
    expect(appCache.bytes).toBe(510);
  });
});
