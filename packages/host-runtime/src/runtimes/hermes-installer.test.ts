import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it, vi } from "vitest";
import { gitTreeHash } from "./hermes-archive.js";
import {
  HERMES_SOURCE_PIN,
  HERMES_SOURCE_TREE,
  hermesInstallLockHeld,
  hermesInstallLockPath,
  readHermesInstallStatus,
} from "./hermes-install.js";
import {
  HERMES_DOWNLOAD_MISMATCH,
  HERMES_HOST_UNAVAILABLE,
  HERMES_INSTALL_FAILED,
  HERMES_INSTALL_RUNNING,
  HERMES_SOURCE_URL,
  type HermesCommand,
  type HermesFetch,
  hermesVersionDirName,
  installHermes,
  installManagedHermes,
} from "./hermes-installer.js";

const files = [
  { path: "dir/a.txt", data: Buffer.from("alpha\n"), mode: 0o644 },
  { path: "dir/b.txt", data: Buffer.from("beta\n"), mode: 0o644 },
  { path: "dir.txt", data: Buffer.from("not-a-dir\n"), mode: 0o644 },
  { path: "script.sh", data: Buffer.from("#!/bin/sh\necho ok\n"), mode: 0o755 },
];

const inherited = {
  UV_EVIL: "1",
  PIP_INDEX_URL: "https://evil.example/simple",
  PYTHONPATH: "/tmp/hidden",
  PYTHONHOME: "/tmp/hidden",
  AWS_SECRET_ACCESS_KEY: "secret-value",
  HTTPS_PROXY: "http://proxy.example:8443",
  HTTP_PROXY: "",
  NO_PROXY: "localhost",
  HOME: "/inherited-home",
  PATH: "/inherited-path",
};

function sourceMap(): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [file.path, createHash("sha256").update(file.data).digest("hex")]),
  );
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  header.write(text, offset, "ascii");
  header[offset + length - 1] = 0;
}

function tarHeader(options: {
  name: string;
  size: number;
  mode: number;
  type: string;
  link?: string;
  prefix?: string;
}): Buffer {
  const header = Buffer.alloc(512, 0);
  Buffer.from(options.name, "utf8").copy(header, 0);
  writeOctal(header, 100, 8, options.mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, options.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = options.type.charCodeAt(0);
  if (options.link) Buffer.from(options.link, "utf8").copy(header, 157);
  header.write("ustar", 257, "ascii");
  header[262] = 0;
  header.write("00", 263, "ascii");
  if (options.prefix) Buffer.from(options.prefix, "utf8").copy(header, 345);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function pad(data: Buffer): Buffer {
  const extra = (512 - (data.length % 512)) % 512;
  return extra === 0 ? data : Buffer.concat([data, Buffer.alloc(extra)]);
}

function entry(options: {
  name: string;
  data?: Buffer;
  mode?: number;
  type?: string;
  link?: string;
  prefix?: string;
}): Buffer {
  const data = options.data ?? Buffer.alloc(0);
  const type = options.type ?? "0";
  return Buffer.concat([
    tarHeader({
      name: options.name,
      size: data.length,
      mode: options.mode ?? (type === "5" ? 0o755 : 0o644),
      type,
      link: options.link,
      prefix: options.prefix,
    }),
    pad(data),
  ]);
}

function paxRecord(key: string, value: string): Buffer {
  const payload = Buffer.from(`${key}=${value}\n`, "utf8");
  let length = payload.length + String(payload.length).length + 1;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const record = Buffer.concat([Buffer.from(`${String(length)} `), payload]);
    if (record.length === length) return record;
    length = record.length;
  }
  throw new Error("pax record length did not settle");
}

function pax(type: "g" | "x", records: Record<string, string>): Buffer {
  const body = Buffer.concat(Object.entries(records).map(([key, value]) => paxRecord(key, value)));
  return entry({ name: type === "g" ? "pax-global" : "pax-next", data: body, type, mode: 0o644 });
}

function gzipTar(parts: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

function sourceArchive(): Buffer {
  const [alpha, beta, plain, script] = files;
  if (!alpha || !beta || !plain || !script) throw new Error("fixture files missing");
  return gzipTar([
    pax("g", { comment: "fixture" }),
    pax("x", { path: "pkg/dir/a.txt" }),
    entry({ name: "short-name", data: alpha.data, mode: alpha.mode }),
    entry({ name: "b.txt", prefix: "pkg/dir", data: beta.data, mode: beta.mode }),
    entry({ name: "pkg/dir.txt", data: plain.data, mode: plain.mode }),
    entry({ name: "pkg/script.sh", data: script.data, mode: script.mode }),
    entry({ name: "pkg/dir/", type: "5", mode: 0o755 }),
  ]);
}

function uvScript(report: string, statusPath: string): string {
  return `#!${process.execPath}
const fs = require("fs");
const path = require("path");
const entry = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  phase: JSON.parse(fs.readFileSync(${JSON.stringify(statusPath)}, "utf8")).phase,
};
fs.appendFileSync(${JSON.stringify(report)}, JSON.stringify(entry) + "\\n");
if (entry.argv[0] === "python" && entry.argv[1] === "install" && entry.argv[2] === "3.13" && entry.argv.length === 3) {
  fs.mkdirSync(path.join(process.env.UV_PYTHON_INSTALL_DIR, "cpython-3.13.2-fixture"), { recursive: true });
  process.exit(0);
}
if (entry.argv[0] === "sync") {
  const bin = path.join(process.env.UV_PROJECT_ENVIRONMENT, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "python"), "#!/bin/sh\\n");
  fs.chmodSync(path.join(bin, "python"), 0o755);
  fs.writeFileSync(path.join(process.env.UV_PROJECT_ENVIRONMENT, "pyvenv.cfg"), "version_info = 3.13.2\\n");
  process.exit(0);
}
process.stderr.write("SECRET_OUTPUT\\n");
process.exit(1);
`;
}

function uvArchive(script: string): { gzip: Buffer; sha256: string } {
  const gzip = gzipTar([
    entry({
      name: "uv-x86_64-unknown-linux-musl/uv",
      data: Buffer.from(script),
      mode: 0o755,
    }),
    entry({
      name: "uv-x86_64-unknown-linux-musl/uvx",
      data: Buffer.from("ignored\n"),
      mode: 0o755,
    }),
  ]);
  return { gzip, sha256: createHash("sha256").update(gzip).digest("hex") };
}

async function gitWriteTree(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-tree-"));
  try {
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-c", "safe.directory=*", ...args], {
        cwd: dir,
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      return result.stdout.trim();
    };
    git("init");
    git("config", "core.filemode", "true");
    git("config", "core.autocrlf", "false");
    for (const file of files) {
      const full = path.join(dir, file.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, file.data);
      await chmod(full, file.mode);
    }
    git("add", "-A");
    return git("write-tree");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function unusedPid(): number {
  for (let pid = 1_000_000; pid < 1_002_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no unused pid");
}

async function writeLock(root: string, pid: number): Promise<void> {
  const lock = hermesInstallLockPath(root);
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ pid, createdAt: "2026-01-01T00:00:00.000Z" }));
}

it("hashes an extracted tree the same way git write-tree does", async () => {
  const expected = await gitWriteTree();
  const dir = await mkdtemp(path.join(tmpdir(), "hermes-hash-"));
  try {
    for (const file of files) {
      const full = path.join(dir, file.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, file.data);
      await chmod(full, file.mode);
    }
    expect(await gitTreeHash(dir)).toBe(expected);
    expect(expected).not.toBe(HERMES_SOURCE_TREE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("installs a verified archive, records the marker, and switches the managed link", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-install-"));
  const report = path.join(root, "uv-report.ndjson");
  const expectedTree = await gitWriteTree();
  const uv = uvArchive(uvScript(report, path.join(root, "install-status.json")));
  const phases: string[] = [];
  const fetchImpl: HermesFetch = async (input, init) => {
    expect(init?.redirect).toBe("manual");
    phases.push(readHermesInstallStatus(root)?.phase ?? "");
    if (input === HERMES_SOURCE_URL) return new Response(sourceArchive());
    if (input.endsWith("/uv-x86_64-unknown-linux-musl.tar.gz")) return new Response(uv.gzip);
    return new Response("missing", { status: 404 });
  };
  await mkdir(path.join(root, "runtimes", hermesVersionDirName()), { recursive: true });
  await writeFile(path.join(root, "runtimes", hermesVersionDirName(), "junk.txt"), "partial");
  await mkdir(path.join(root, "runtimes", "hermes-agent-partial"), { recursive: true });
  await writeFile(path.join(root, "runtimes", "hermes-agent-partial", "junk.txt"), "partial");
  const kept = path.join(root, "runtimes", "hermes-agent-aaaaaaaaaaaa");
  await mkdir(kept, { recursive: true });
  await writeFile(path.join(kept, ".ardur-install.json"), '{"pin":"kept"}');
  await writeFile(path.join(kept, "keep.txt"), "keep");
  // Another Python patch already present must not confuse the marker.
  await mkdir(path.join(root, "runtimes", "python", "cpython-3.13.9-other"), {
    recursive: true,
  });
  await writeLock(root, unusedPid());
  try {
    try {
      await installHermes({
        root,
        fetch: fetchImpl,
        platform: "linux",
        arch: "x64",
        expectedTree,
        sources: sourceMap(),
        uvSha256: uv.sha256,
        now: () => new Date("2026-01-02T03:04:05.000Z"),
        env: inherited,
      });
    } catch (error) {
      const log = await readFile(path.join(root, "runtimes", ".install.log"), "utf8").catch(
        () => "",
      );
      const cause = error instanceof Error ? error.cause : undefined;
      const detail = cause instanceof Error ? `\n${cause.stack}` : "";
      throw new Error(`${error instanceof Error ? error.message : error}\n${log}${detail}`, {
        cause: error,
      });
    }
    const versionDir = path.join(root, "runtimes", hermesVersionDirName());
    const marker = JSON.parse(await readFile(path.join(versionDir, ".ardur-install.json"), "utf8"));
    expect(marker).toEqual({
      pin: HERMES_SOURCE_PIN,
      tree: expectedTree,
      uv: "0.12.19",
      python: "3.13.2",
      installedAt: "2026-01-02T03:04:05.000Z",
    });
    const link = path.join(root, "runtimes", "hermes-agent");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(hermesVersionDirName());
    expect(statSync(path.join(versionDir, "script.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(path.join(versionDir, "dir", "a.txt")).mode & 0o777).toBe(0o644);
    expect(statSync(path.join(root, "runtimes", "uv", "0.12.19", "uv")).mode & 0o777).toBe(0o755);
    expect(readHermesInstallStatus(root)).toMatchObject({
      state: "ready",
      message: "Ready.",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(phases).toEqual(["downloading", "checking"]);
    const calls = (await readFile(report, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map((call: { argv: string[]; phase: string }) => [call.phase, call.argv])).toEqual(
      [
        ["python", ["python", "install", "3.13"]],
        [
          "packages",
          [
            "sync",
            "--frozen",
            "--no-dev",
            "--python",
            "3.13",
            "--extra",
            "acp",
            "--extra",
            "mcp",
            "--extra",
            "computer-use",
            "--extra",
            "web",
          ],
        ],
      ],
    );
    for (const call of calls) {
      expect(call.cwd).toBe(realpathSync(versionDir));
      expect(call.env.HOME).not.toBe("/inherited-home");
      expect(call.env.PATH).toBe("/usr/bin:/bin");
      expect(call.env.UV_PYTHON_PREFERENCE).toBe("only-managed");
      expect(call.env.UV_NO_CONFIG).toBe("1");
      expect(call.env.UV_PYTHON_INSTALL_DIR).toBe(path.join(root, "runtimes", "python"));
      expect(call.env.UV_CACHE_DIR).toBe(path.join(root, "runtimes", ".uv-cache"));
      expect(call.env.UV_PROJECT_ENVIRONMENT).toBe(path.join(versionDir, ".venv"));
      expect(call.env.HTTPS_PROXY).toBe("http://proxy.example:8443");
      expect(call.env.NO_PROXY).toBe("localhost");
      expect(call.env.HTTP_PROXY).toBeUndefined();
      expect(call.env.UV_EVIL).toBeUndefined();
      expect(call.env.PIP_INDEX_URL).toBeUndefined();
      expect(call.env.PYTHONPATH).toBeUndefined();
      expect(call.env.PYTHONHOME).toBeUndefined();
      expect(call.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(
        Object.keys(call.env).some((key) => key.startsWith("PIP_") || key.startsWith("PYTHON")),
      ).toBe(false);
    }
    expect(() => statSync(path.join(root, "runtimes", ".uv-cache"))).toThrow();
    expect(await readFile(path.join(kept, "keep.txt"), "utf8")).toBe("keep");
    await expect(
      readFile(path.join(root, "runtimes", "hermes-agent-partial", "junk.txt")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, "runtimes", hermesVersionDirName(), "junk.txt")),
    ).rejects.toThrow();
    expect(hermesInstallLockHeld(root)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a tree that is not the approved revision and deletes it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-mismatch-"));
  const urls: string[] = [];
  const fetchImpl: HermesFetch = async (input) => {
    urls.push(input);
    return new Response(sourceArchive());
  };
  try {
    await expect(
      installHermes({
        root,
        fetch: fetchImpl,
        platform: "linux",
        arch: "x64",
        uvSha256: "ignored",
        now: () => new Date("2026-01-02T03:04:05.000Z"),
      }),
    ).rejects.toThrow(HERMES_DOWNLOAD_MISMATCH);
    expect(urls).toEqual([HERMES_SOURCE_URL]);
    await expect(
      readFile(path.join(root, "runtimes", hermesVersionDirName(), "script.sh")),
    ).rejects.toThrow();
    expect(readHermesInstallStatus(root)).toMatchObject({
      state: "failed",
      message: HERMES_DOWNLOAD_MISMATCH,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a uv archive whose sha256 is not the pinned asset", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-uv-sha-"));
  const expectedTree = await gitWriteTree();
  const fetchImpl: HermesFetch = async (input) => {
    if (input === HERMES_SOURCE_URL) return new Response(sourceArchive());
    return new Response(uvArchive("#!/bin/sh\n").gzip);
  };
  try {
    await expect(
      installHermes({
        root,
        fetch: fetchImpl,
        platform: "linux",
        arch: "x64",
        expectedTree,
        sources: sourceMap(),
      }),
    ).rejects.toThrow(HERMES_INSTALL_FAILED);
    await expect(readFile(path.join(root, "runtimes", "uv", "0.12.19", "uv"))).rejects.toThrow();
    await expect(
      readFile(path.join(root, "runtimes", hermesVersionDirName(), "script.sh")),
    ).rejects.toThrow();
    expect(readHermesInstallStatus(root)?.message).toBe(HERMES_INSTALL_FAILED);
    expect(readHermesInstallStatus(root)?.message).not.toBe(HERMES_DOWNLOAD_MISMATCH);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a redirect to a host outside the GitHub download allowlist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-redirect-"));
  const fetchImpl: HermesFetch = async () =>
    new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/hermes.tar.gz" },
    });
  try {
    await expect(
      installHermes({ root, fetch: fetchImpl, platform: "linux", arch: "x64" }),
    ).rejects.toThrow(HERMES_INSTALL_FAILED);
    expect(readHermesInstallStatus(root)?.message).not.toContain("evil.example");
    await expect(
      readFile(path.join(root, "runtimes", hermesVersionDirName(), "script.sh")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("follows a redirect that stays on an allowed host", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-redirect-ok-"));
  const urls: string[] = [];
  const fetchImpl: HermesFetch = async (input) => {
    urls.push(input);
    if (input === HERMES_SOURCE_URL) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://objects.githubusercontent.com/fixture.tar.gz" },
      });
    }
    return new Response(sourceArchive());
  };
  try {
    await expect(
      installHermes({ root, fetch: fetchImpl, platform: "linux", arch: "x64" }),
    ).rejects.toThrow(HERMES_DOWNLOAD_MISMATCH);
    expect(urls).toEqual([
      HERMES_SOURCE_URL,
      "https://objects.githubusercontent.com/fixture.tar.gz",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("stops after the redirect cap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-redirect-loop-"));
  let hops = 0;
  const fetchImpl: HermesFetch = async () => {
    hops += 1;
    if (hops > 8) throw new Error("redirect loop");
    return new Response(null, {
      status: 302,
      headers: { location: "https://github.com/again.tar.gz" },
    });
  };
  try {
    await expect(
      installHermes({ root, fetch: fetchImpl, platform: "linux", arch: "x64" }),
    ).rejects.toThrow(HERMES_INSTALL_FAILED);
    expect(hops).toBeLessThanOrEqual(6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a download larger than the cap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-oversize-"));
  const fetchImpl: HermesFetch = async () => new Response(sourceArchive());
  try {
    await expect(
      installHermes({
        root,
        fetch: fetchImpl,
        platform: "linux",
        arch: "x64",
        downloadLimit: 32,
      }),
    ).rejects.toThrow(HERMES_INSTALL_FAILED);
    await expect(
      readFile(path.join(root, "runtimes", hermesVersionDirName(), "script.sh")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const unsafeArchives: Array<[string, Buffer[]]> = [
  [
    "path traversal",
    [
      pax("x", { path: "pkg/../../escaped.txt" }),
      entry({ name: "pkg/ok.txt", data: Buffer.from("x") }),
    ],
  ],
  ["symlink", [entry({ name: "pkg/link", type: "2", link: "pkg/script.sh", mode: 0o777 })]],
  ["hard link", [entry({ name: "pkg/hard", type: "1", link: "pkg/script.sh" })]],
];
it.each(unsafeArchives)("refuses an archive %s entry", async (_label, parts) => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-unsafe-"));
  const fetchImpl: HermesFetch = async () => new Response(gzipTar(parts));
  try {
    await expect(
      installHermes({ root, fetch: fetchImpl, platform: "linux", arch: "x64" }),
    ).rejects.toThrow(HERMES_INSTALL_FAILED);
    expect(() => lstatSync(path.join(root, "escaped.txt"))).toThrow();
    await expect(
      readFile(path.join(root, "runtimes", hermesVersionDirName(), "ok.txt")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, "runtimes", hermesVersionDirName(), "link")),
    ).rejects.toThrow();
    await expect(
      readFile(path.join(root, "runtimes", hermesVersionDirName(), "hard")),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("records the python version the environment reports when pyvenv.cfg is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-python-version-"));
  const expectedTree = await gitWriteTree();
  const script = `#!${process.execPath}
const fs = require("fs");
const path = require("path");
if (process.argv[2] === "sync") {
  const bin = path.join(process.env.UV_PROJECT_ENVIRONMENT, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "python"), "#!/bin/sh\\necho 3.13.11\\n");
  fs.chmodSync(path.join(bin, "python"), 0o755);
}
process.exit(0);
`;
  const uv = uvArchive(script);
  try {
    await installHermes({
      root,
      fetch: async (input) =>
        new Response(input === HERMES_SOURCE_URL ? sourceArchive() : uv.gzip),
      platform: "linux",
      arch: "x64",
      expectedTree,
      sources: sourceMap(),
      uvSha256: uv.sha256,
    });
    const marker = JSON.parse(
      await readFile(
        path.join(root, "runtimes", hermesVersionDirName(), ".ardur-install.json"),
        "utf8",
      ),
    );
    expect(marker.python).toBe("3.13.11");
    expect(readHermesInstallStatus(root)?.state).toBe("ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a second install while the lock is held", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-lock-"));
  await writeLock(root, process.pid);
  await writeFile(
    path.join(root, "install-status.json"),
    `${JSON.stringify({
      state: "installing",
      phase: "downloading",
      message: "Downloading.",
      updatedAt: "2026-01-02T03:04:05.000Z",
    })}\n`,
  );
  const fetchImpl = vi.fn<HermesFetch>();
  try {
    await expect(
      installHermes({ root, fetch: fetchImpl, platform: "linux", arch: "x64" }),
    ).rejects.toThrow(HERMES_INSTALL_RUNNING);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(readHermesInstallStatus(root)).toMatchObject({
      state: "installing",
      phase: "downloading",
    });
    expect(hermesInstallLockHeld(root)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("treats an unreadable lock as held and never steals it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-garbage-lock-"));
  const lock = hermesInstallLockPath(root);
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, "not json {");
  const fetchImpl = vi.fn<HermesFetch>();
  try {
    expect(hermesInstallLockHeld(root)).toBe(true);
    await expect(
      installHermes({ root, fetch: fetchImpl, platform: "linux", arch: "x64" }),
    ).rejects.toThrow(HERMES_INSTALL_RUNNING);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(lock, "utf8")).toBe("not json {");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("locks atomically so a concurrent installer sees a complete lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-lock-race-"));
  const report = path.join(root, "uv-report.ndjson");
  const expectedTree = await gitWriteTree();
  const uv = uvArchive(uvScript(report, path.join(root, "install-status.json")));
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const fetchImpl: HermesFetch = async (input) => {
    if (input === HERMES_SOURCE_URL) {
      await gate;
      return new Response(sourceArchive());
    }
    return new Response(uv.gzip);
  };
  const deps = {
    root,
    fetch: fetchImpl,
    platform: "linux" as const,
    arch: "x64",
    expectedTree,
    sources: sourceMap(),
    uvSha256: uv.sha256,
  };
  try {
    const first = installHermes(deps);
    const deadline = Date.now() + 10_000;
    while (!hermesInstallLockHeld(root)) {
      if (Date.now() > deadline) throw new Error("the first install never took the lock");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Every read of the lock file sees complete JSON, never a partial write.
    for (let check = 0; check < 20; check += 1) {
      const parsed = JSON.parse(await readFile(hermesInstallLockPath(root), "utf8")) as {
        pid?: unknown;
      };
      expect(parsed.pid).toBe(process.pid);
    }
    await expect(installHermes(deps)).rejects.toThrow(HERMES_INSTALL_RUNNING);
    openGate();
    await first;
    expect(hermesInstallLockHeld(root)).toBe(false);
    expect(readHermesInstallStatus(root)?.state).toBe("ready");
  } finally {
    openGate();
    await rm(root, { recursive: true, force: true });
  }
});

it("treats a dead pid as free and keeps a live lock held at any age", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-stale-lock-"));
  try {
    await writeLock(root, unusedPid());
    expect(hermesInstallLockHeld(root)).toBe(false);
    await writeLock(root, process.pid);
    const lock = hermesInstallLockPath(root);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(lock, old, old);
    expect(hermesInstallLockHeld(root)).toBe(true);
    await expect(
      installHermes({ root, fetch: vi.fn<HermesFetch>(), platform: "linux", arch: "x64" }),
    ).rejects.toThrow(HERMES_INSTALL_RUNNING);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not release a lock another installer took over", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-lock-takeover-"));
  const report = path.join(root, "uv-report.ndjson");
  const expectedTree = await gitWriteTree();
  const uv = uvArchive(uvScript(report, path.join(root, "install-status.json")));
  let openGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const fetchImpl: HermesFetch = async (input) => {
    if (input === HERMES_SOURCE_URL) {
      await gate;
      return new Response(sourceArchive());
    }
    return new Response(uv.gzip);
  };
  try {
    const first = installHermes({
      root,
      fetch: fetchImpl,
      platform: "linux",
      arch: "x64",
      expectedTree,
      sources: sourceMap(),
      uvSha256: uv.sha256,
    });
    const deadline = Date.now() + 10_000;
    while (!hermesInstallLockHeld(root)) {
      if (Date.now() > deadline) throw new Error("the install never took the lock");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const lock = hermesInstallLockPath(root);
    const ours = JSON.parse(await readFile(lock, "utf8")) as { token?: unknown };
    expect(typeof ours.token).toBe("string");
    // Another installer steals the stale lock and records its own token.
    await writeFile(
      lock,
      JSON.stringify({
        pid: process.pid,
        token: "another-installer",
        createdAt: "2026-01-02T03:04:05.000Z",
      }),
    );
    openGate();
    await first;
    const remaining = JSON.parse(await readFile(lock, "utf8")) as { token?: unknown };
    expect(remaining.token).toBe("another-installer");
    expect(hermesInstallLockHeld(root)).toBe(true);
  } finally {
    openGate();
    await rm(root, { recursive: true, force: true });
  }
});

it("hides command output from the install error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-secret-"));
  const expectedTree = await gitWriteTree();
  const uv = uvArchive("#!/bin/sh\n");
  const spawn: HermesCommand = async () => ({
    code: 1,
    stdout: "",
    stderr: "SECRET_OUTPUT /tmp/hidden",
  });
  try {
    await expect(
      installHermes({
        root,
        fetch: async (input) =>
          new Response(input === HERMES_SOURCE_URL ? sourceArchive() : uv.gzip),
        spawn,
        platform: "linux",
        arch: "x64",
        expectedTree,
        sources: sourceMap(),
        uvSha256: uv.sha256,
      }),
    ).rejects.toThrow(HERMES_INSTALL_FAILED);
    expect(readHermesInstallStatus(root)?.message).toBe(HERMES_INSTALL_FAILED);
    expect(readHermesInstallStatus(root)?.message).not.toContain("SECRET_OUTPUT");
    expect(await readFile(path.join(root, "runtimes", ".install.log"), "utf8")).toContain(
      "SECRET_OUTPUT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses an unsupported platform with the existing host reason", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-platform-"));
  const fetchImpl = vi.fn<HermesFetch>();
  try {
    await expect(
      installHermes({ root, fetch: fetchImpl, platform: "win32", arch: "x64" }),
    ).rejects.toThrow(HERMES_HOST_UNAVAILABLE);
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does nothing in bridge mode", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hermes-bridge-"));
  vi.stubEnv("ARDURBOT_HOST_BRIDGE", "api");
  vi.stubEnv("DATA_DIR", root);
  try {
    await installManagedHermes();
    expect(readHermesInstallStatus(path.join(root, "hermes"))).toBeNull();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
