import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HERMES_SOURCE_PIN, HERMES_SOURCE_TREE } from "./hermes-install.js";
import {
  HERMES_INSTALL_RUNNING,
  HermesInstallError,
  runHermesInstallJob,
} from "./hermes-installer.js";

vi.mock("../../python/hermes_sources.json", () => ({ default: {} }));

describe("Hermes install job", () => {
  let data = "";
  const roots: string[] = [];

  beforeEach(async () => {
    data = await mkdtemp(path.join(tmpdir(), "hermes-install-job-"));
    roots.push(data);
    vi.stubEnv("DATA_DIR", data);
    vi.stubEnv("ARDUR_HERMES_INSTALL", "");
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  function hermesRoot(): string {
    return path.join(path.resolve(data), "hermes");
  }

  async function writeLock(pid: number): Promise<void> {
    const lock = path.join(hermesRoot(), "runtimes", ".install.lock");
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, JSON.stringify({ pid, createdAt: "2026-01-02T03:04:05.000Z" }));
  }

  async function writeQualified(): Promise<void> {
    const managed = path.join(hermesRoot(), "runtimes", "hermes-agent", ".venv", "bin");
    await mkdir(managed, { recursive: true });
    await writeFile(path.join(managed, "python"), "fixture");
    await writeFile(
      path.join(hermesRoot(), "runtimes", "hermes-agent", ".ardur-install.json"),
      JSON.stringify({ pin: HERMES_SOURCE_PIN, tree: HERMES_SOURCE_TREE }),
    );
  }

  it("does nothing in bridge mode", async () => {
    vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
    const install = vi.fn(async () => undefined);
    await runHermesInstallJob(install);
    expect(install).not.toHaveBeenCalled();
  });

  it("does not disturb a running install", async () => {
    await writeLock(process.pid);
    const status = path.join(hermesRoot(), "install-status.json");
    await writeFile(
      status,
      JSON.stringify({
        state: "installing",
        phase: "downloading",
        message: "Downloading.",
        updatedAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    const install = vi.fn(async () => undefined);
    await runHermesInstallJob(install);
    expect(install).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(status, "utf8"))).toMatchObject({
      state: "installing",
      phase: "downloading",
    });
  });

  it("does nothing when the managed install already qualifies", async () => {
    await writeQualified();
    const install = vi.fn(async () => undefined);
    await runHermesInstallJob(install);
    expect(install).not.toHaveBeenCalled();
  });

  it("starts an install when nothing qualifies", async () => {
    const install = vi.fn(async () => undefined);
    await runHermesInstallJob(install);
    expect(install).toHaveBeenCalledOnce();
  });

  it("starts an install when the lock belongs to a dead process", async () => {
    await writeLock(-1);
    const install = vi.fn(async () => undefined);
    await runHermesInstallJob(install);
    expect(install).toHaveBeenCalledOnce();
  });

  it("treats a lost race for the lock as already running", async () => {
    const install = vi.fn(async () => {
      throw new HermesInstallError(HERMES_INSTALL_RUNNING);
    });
    await expect(runHermesInstallJob(install)).resolves.toBeUndefined();
  });

  it("lets any other install failure fail the job", async () => {
    const install = vi.fn(async () => {
      throw new Error("disk full");
    });
    await expect(runHermesInstallJob(install)).rejects.toThrow("disk full");
  });
});
