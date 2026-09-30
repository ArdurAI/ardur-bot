import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitTreeIdOfArchive } from "./hermes-archive.js";
import {
  HERMES_SOURCE_PIN,
  HERMES_SOURCE_TREE,
  readHermesInstallStatus,
} from "./hermes-install.js";
import {
  HERMES_INSTALL_RUNNING,
  HERMES_SOURCE_URL,
  type HermesCommand,
  HermesInstallError,
  installHermes,
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

  it("takes a case-colliding install from downloading to done", async () => {
    // The status a real installer would have published before the download began.
    await mkdir(hermesRoot(), { recursive: true });
    await writeFile(
      path.join(hermesRoot(), "install-status.json"),
      JSON.stringify({
        state: "installing",
        phase: "downloading",
        message: "Downloading.",
        updatedAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    // An in-memory archive whose two notes entries differ only by letter case.
    const top = "rel";
    const parts = [
      { name: `${top}/notes/Team.txt`, data: Buffer.from("first\n"), mode: 0o644 },
      { name: `${top}/notes/team.txt`, data: Buffer.from("second\n"), mode: 0o644 },
      { name: `${top}/pyproject.toml`, data: Buffer.from("[project]\n"), mode: 0o644 },
    ];
    const uvParts = [{ name: `${top}/uv`, data: Buffer.from("#!/bin/sh\n"), mode: 0o755 }];
    const header = (name: string, size: number, mode: number): Buffer => {
      const block = Buffer.alloc(512, 0);
      Buffer.from(name, "utf8").copy(block, 0);
      block.write(mode.toString(8).padStart(7, "0"), 100, "ascii");
      block[107] = 0;
      block.write(size.toString(8).padStart(11, "0"), 124, "ascii");
      block[135] = 0;
      block.fill(0x20, 148, 156);
      block[156] = 0x30;
      block.write("ustar", 257, "ascii");
      block[262] = 0;
      block.write("00", 263, "ascii");
      let sum = 0;
      for (const byte of block) sum += byte;
      block.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
      block[154] = 0;
      block[155] = 0x20;
      return block;
    };
    const entryBlock = (part: { name: string; data: Buffer; mode: number }): Buffer => {
      const extra = (512 - (part.data.length % 512)) % 512;
      return Buffer.concat([
        header(part.name, part.data.length, part.mode),
        part.data,
        Buffer.alloc(extra),
      ]);
    };
    const tarOf = (entries: { name: string; data: Buffer; mode: number }[]) =>
      gzipSync(Buffer.concat([...entries.map(entryBlock), Buffer.alloc(1024)]));
    const archive = tarOf(parts);
    const uvArchive = tarOf(uvParts);
    const uvSha256 = createHash("sha256").update(uvArchive).digest("hex");
    const expectedTree = await gitTreeIdOfArchive(archive, 2 * 1024 * 1024);
    // A command stub that stands up the environment the marker is drawn from.
    const spawn: HermesCommand = async (_command, args, options) => {
      if (args[0] === "sync") {
        const venv = options.env.UV_PROJECT_ENVIRONMENT;
        if (!venv) return { code: 1, stdout: "", stderr: "no environment" };
        await mkdir(path.join(venv, "bin"), { recursive: true });
        await writeFile(path.join(venv, "bin", "python"), "#!/bin/sh\n");
        await writeFile(path.join(venv, "pyvenv.cfg"), "version_info = 3.13.2\n");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const install = async () => {
      await installHermes({
        root: hermesRoot(),
        fetch: async (input) => new Response(input === HERMES_SOURCE_URL ? archive : uvArchive),
        platform: "linux",
        arch: "x64",
        expectedTree,
        uvSha256,
        spawn,
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        env: {},
      });
    };
    await runHermesInstallJob(install);
    expect(readHermesInstallStatus(hermesRoot())).toMatchObject({
      state: "ready",
      message: "Ready.",
    });
    // The first of the colliding pair is kept on this disk.
    expect(
      await readFile(
        path.join(hermesRoot(), "runtimes", "hermes-agent", "notes", "Team.txt"),
        "utf8",
      ),
    ).toBe("first\n");
    const marker = JSON.parse(
      await readFile(
        path.join(hermesRoot(), "runtimes", "hermes-agent", ".ardur-install.json"),
        "utf8",
      ),
    );
    expect(marker.tree).toBe(expectedTree);
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
