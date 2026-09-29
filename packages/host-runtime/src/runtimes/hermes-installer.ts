import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractSourceArchive, extractUvBinary, gitTreeHash } from "./hermes-archive.js";
import {
  HERMES_SOURCE_PIN,
  HERMES_SOURCE_TREE,
  type HermesInstallPhase,
  type HermesInstallStatus,
  hermesInstallLockHeld,
  hermesInstallLockPath,
  hermesInstallStatusPath,
  localHermesInstallCandidate,
  localHermesRoot,
  probeHermesInstall,
  qualifyHermesInstall,
} from "./hermes-install.js";

export const HERMES_SOURCE_URL =
  "https://codeload.github.com/NousResearch/hermes-agent/tar.gz/29112bef099274229cadff79cdff7bf7b99c4b77";
export const UV_VERSION = "0.12.19";
export const HERMES_DOWNLOAD_MISMATCH = "The Hermes download didn't match the approved version.";
export const HERMES_INSTALL_FAILED = "Couldn't install Hermes. Try again.";
export const HERMES_INSTALL_RUNNING = "Hermes is already being installed.";
export const HERMES_INSTALL_ALREADY = "Hermes is already installed.";
export const HERMES_INSTALL_BRIDGE = "Install Hermes from Ardur on this computer.";
export const HERMES_HOST_UNAVAILABLE = "Pinned Hermes is unavailable on this host.";

const PHASE_TEXT: Record<HermesInstallPhase, string> = {
  downloading: "Downloading.",
  checking: "Checking the download.",
  python: "Setting up Python.",
  packages: "Installing packages.",
  finishing: "Finishing.",
};

const SOURCE_BYTES = 100 * 1024 * 1024;
const UV_BYTES = 60 * 1024 * 1024;
const EXTRACT_BYTES = 500 * 1024 * 1024;
const EXTRACT_FILES = 20_000;
const UV_INFLATED = 80 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const LOG_BYTES = 64 * 1024;
const ALLOWED_HOSTS = new Set([
  "codeload.github.com",
  "github.com",
  "objects.githubusercontent.com",
]);

const UV_ASSETS: Record<string, { file: string; sha256: string }> = {
  "darwin:arm64": {
    file: "uv-aarch64-apple-darwin.tar.gz",
    sha256: "a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba",
  },
  "darwin:x64": {
    file: "uv-x86_64-apple-darwin.tar.gz",
    sha256: "cb5fa57bafe68fc0fb94b17f06bee0b0b9a7feb94ccbd110445afa0696e39273",
  },
  "linux:arm64": {
    file: "uv-aarch64-unknown-linux-musl.tar.gz",
    sha256: "ad8d8448a2ff642ba62c2f684d7dd22a03f8eb3fc9918c2c3e8ec975f4ed6710",
  },
  "linux:x64": {
    file: "uv-x86_64-unknown-linux-musl.tar.gz",
    sha256: "db7278c9f57981338fddff1fb250e11964bc0a4fafcb9eed8303fdb117dc067b",
  },
};

export type HermesCommand = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type HermesFetch = (
  input: string,
  init?: { redirect?: "manual"; signal?: AbortSignal },
) => Promise<Response>;

export function hermesVersionDirName(): string {
  return `hermes-agent-${HERMES_SOURCE_PIN.slice(0, 12)}`;
}

export function uvRelease(platform: string, arch: string): { url: string; sha256: string } | null {
  const asset = UV_ASSETS[`${platform}:${arch}`];
  if (!asset) return null;
  return {
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset.file}`,
    sha256: asset.sha256,
  };
}

export class HermesInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HermesInstallError";
  }
}

export async function installManagedHermes(): Promise<void> {
  if (process.env.ARDURBOT_HOST_BRIDGE === "api") return;
  await installHermes({ root: localHermesRoot() });
}

/** Worker entry. A paired host, a live lock, or an install that already qualifies does nothing. */
export async function runHermesInstallJob(install?: () => Promise<void>): Promise<void> {
  if (process.env.ARDURBOT_HOST_BRIDGE === "api") return;
  const root = localHermesRoot();
  if (hermesInstallLockHeld(root)) return;
  const candidate = localHermesInstallCandidate();
  if (candidate) {
    try {
      probeHermesInstall(candidate);
      return;
    } catch {
      // A present candidate that fails its checks can be replaced.
    }
  }
  try {
    await (install ?? (() => installHermes({ root })))();
  } catch (error) {
    if (error instanceof HermesInstallError && error.message === HERMES_INSTALL_RUNNING) return;
    throw error;
  }
}

export async function installHermes(deps: {
  root: string;
  fetch?: HermesFetch;
  spawn?: HermesCommand;
  now?: () => Date;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  expectedTree?: string;
  sources?: Record<string, string>;
  uvSha256?: string;
  downloadLimit?: number;
  uvDownloadLimit?: number;
  extractBytes?: number;
  extractFiles?: number;
  downloadTimeoutMs?: number;
  commandTimeoutMs?: number;
}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const release = uvRelease(platform, arch);
  if (platform === "win32" || !release) throw new HermesInstallError(HERMES_HOST_UNAVAILABLE);

  const root = deps.root;
  const clock = deps.now ?? (() => new Date());
  const versionName = hermesVersionDirName();
  const versionDir = path.join(root, "runtimes", versionName);
  const verifiedTree = deps.expectedTree ?? HERMES_SOURCE_TREE;
  const testing = deps.expectedTree !== undefined || deps.sources !== undefined;
  let locked = false;
  let lockToken: string | undefined;
  let committed = false;
  let phase: HermesInstallPhase | undefined;
  let home: string | undefined;

  try {
    lockToken = await acquireLock(root);
    locked = true;
    if (!testing && liveInstallReady(path.join(root, "runtimes", "hermes-agent"))) {
      await writeStatus(root, {
        state: "ready",
        message: "Ready.",
        updatedAt: clock().toISOString(),
      });
      return;
    }
    phase = "downloading";
    await writeStatus(root, phaseStatus(phase, clock));
    await removeStaleVersions(root, versionName);
    await writeFile(path.join(root, "runtimes", ".install.log"), "", { mode: 0o600 });

    const source = await download(
      HERMES_SOURCE_URL,
      deps.fetch,
      deps.downloadLimit ?? SOURCE_BYTES,
      deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    );
    phase = "checking";
    await writeStatus(root, phaseStatus(phase, clock));
    const extractBytes = deps.extractBytes ?? EXTRACT_BYTES;
    const extractFiles = deps.extractFiles ?? EXTRACT_FILES;
    await extractSourceArchive(source, versionDir, {
      files: extractFiles,
      bytes: extractBytes,
      inflated: extractBytes + extractFiles * 512 + 1024,
    });
    const actualTree = await gitTreeHash(versionDir);
    if (actualTree !== verifiedTree) {
      await rm(versionDir, { recursive: true, force: true });
      throw new HermesInstallError(HERMES_DOWNLOAD_MISMATCH);
    }

    const uvArchive = await download(
      release.url,
      deps.fetch,
      deps.uvDownloadLimit ?? UV_BYTES,
      deps.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS,
    );
    if (sha256(uvArchive) !== (deps.uvSha256 ?? release.sha256))
      throw new HermesInstallError(HERMES_INSTALL_FAILED);
    const uvBinary = path.join(root, "runtimes", "uv", UV_VERSION, "uv");
    await extractUvBinary(uvArchive, uvBinary, UV_INFLATED);

    home = await mkdtemp(path.join(tmpdir(), "hermes-uv-"));
    const run = deps.spawn ?? defaultCommand;
    const commandEnv = uvEnvironment(root, versionDir, home, deps.env ?? process.env);
    const timeoutMs = deps.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
    phase = "python";
    await writeStatus(root, phaseStatus(phase, clock));
    await runChecked(run, uvBinary, ["python", "install", "3.13"], {
      cwd: versionDir,
      env: commandEnv,
      timeoutMs,
      log: path.join(root, "runtimes", ".install.log"),
    });
    phase = "packages";
    await writeStatus(root, phaseStatus(phase, clock));
    await runChecked(
      run,
      uvBinary,
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
      {
        cwd: versionDir,
        env: commandEnv,
        timeoutMs,
        log: path.join(root, "runtimes", ".install.log"),
      },
    );

    phase = "finishing";
    await writeStatus(root, phaseStatus(phase, clock));
    const python = readPythonPatch(path.join(root, "runtimes", "python"));
    const installedAt = clock().toISOString();
    await writeFile(
      path.join(versionDir, ".ardur-install.json"),
      `${JSON.stringify({
        pin: HERMES_SOURCE_PIN,
        tree: verifiedTree,
        uv: UV_VERSION,
        python,
        installedAt,
      })}\n`,
      { mode: 0o644 },
    );
    if (testing)
      qualifyHermesInstall(versionDir, { tree: verifiedTree, sources: deps.sources ?? {} });
    else probeHermesInstall(versionDir);
    await switchInstallLink(root, versionName);
    committed = true;
    await rm(path.join(root, "runtimes", ".uv-cache"), { recursive: true, force: true });
    await writeStatus(root, { state: "ready", message: "Ready.", updatedAt: installedAt });
  } catch (error) {
    const message = error instanceof HermesInstallError ? error.message : HERMES_INSTALL_FAILED;
    if (locked && message !== HERMES_INSTALL_RUNNING) {
      await writeStatus(root, {
        state: "failed",
        ...(phase ? { phase } : {}),
        message: publicFailure(message),
        updatedAt: clock().toISOString(),
      }).catch(() => undefined);
      if (!committed) await rm(versionDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (error instanceof HermesInstallError) throw error;
    const failure = new HermesInstallError(HERMES_INSTALL_FAILED);
    failure.cause = error;
    throw failure;
  } finally {
    if (lockToken) await releaseLock(root, lockToken);
    if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

function publicFailure(message: string): string {
  if (message === HERMES_DOWNLOAD_MISMATCH || message === HERMES_HOST_UNAVAILABLE) return message;
  return HERMES_INSTALL_FAILED;
}

function phaseStatus(phase: HermesInstallPhase, clock: () => Date): HermesInstallStatus {
  return {
    state: "installing",
    phase,
    message: PHASE_TEXT[phase],
    updatedAt: clock().toISOString(),
  };
}

function liveInstallReady(link: string): boolean {
  try {
    if (!lstatSync(link).isSymbolicLink()) return false;
    probeHermesInstall(link);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(root: string): Promise<string> {
  const lockPath = hermesInstallLockPath(root);
  const directory = path.dirname(lockPath);
  await mkdir(directory, { recursive: true });
  const token = randomUUID();
  const body = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // Write the full body to a temp file and link it into place, so a concurrent
    // reader never sees an empty or partial lock.
    const temporary = path.join(directory, `.install.lock.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: "wx", mode: 0o644 });
      await link(temporary, lockPath);
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new HermesInstallError(HERMES_INSTALL_FAILED);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    if (hermesInstallLockHeld(root)) throw new HermesInstallError(HERMES_INSTALL_RUNNING);
    let current = "";
    try {
      current = await readFile(lockPath, "utf8");
    } catch {
      continue;
    }
    if (hermesInstallLockHeld(root)) throw new HermesInstallError(HERMES_INSTALL_RUNNING);
    try {
      if ((await readFile(lockPath, "utf8")) !== current) continue;
      await rm(lockPath, { force: true });
    } catch {
      // The other install replaced the stale lock.
    }
  }
  throw new HermesInstallError(HERMES_INSTALL_RUNNING);
}

/** Only the lock whose recorded token is ours is released; a stolen lock is left alone. */
async function releaseLock(root: string, token: string): Promise<void> {
  const lockPath = hermesInstallLockPath(root);
  try {
    const parsed = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
    if (parsed.token !== token) return;
    await rm(lockPath, { force: true });
  } catch {
    // The lock is already gone.
  }
}

async function removeStaleVersions(root: string, versionName: string): Promise<void> {
  const runtimes = path.join(root, "runtimes");
  let names: string[] = [];
  try {
    names = await readdir(runtimes);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("hermes-agent-")) continue;
    const full = path.join(runtimes, name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) {
      await unlink(full);
      continue;
    }
    if (!stat.isDirectory()) continue;
    const marked = existsSync(path.join(full, ".ardur-install.json"));
    if (!marked || name === versionName) await rm(full, { recursive: true, force: true });
  }
}

async function writeStatus(root: string, status: HermesInstallStatus): Promise<void> {
  await mkdir(root, { recursive: true });
  const temporary = path.join(root, `.install-status.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(status)}\n`, { mode: 0o644 });
  await rename(temporary, hermesInstallStatusPath(root));
}

async function switchInstallLink(root: string, versionName: string): Promise<void> {
  const link = path.join(root, "runtimes", "hermes-agent");
  const temporary = path.join(root, "runtimes", `.hermes-agent.${process.pid}.tmp`);
  await rm(temporary, { force: true });
  await symlink(versionName, temporary);
  try {
    let existing: { isSymbolicLink(): boolean } | undefined;
    try {
      existing = lstatSync(link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new HermesInstallError(HERMES_INSTALL_FAILED);
    }
    if (existing && !existing.isSymbolicLink()) throw new HermesInstallError(HERMES_INSTALL_FAILED);
    await rename(temporary, link);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof HermesInstallError) throw error;
    throw new HermesInstallError(HERMES_INSTALL_FAILED);
  }
}

function readPythonPatch(directory: string): string {
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    throw new HermesInstallError(HERMES_INSTALL_FAILED);
  }
  const patches = new Set<number>();
  for (const name of names) {
    const match = /^cpython-3\.13\.(\d+)(?:\D.*)?$/.exec(name);
    if (match?.[1]) patches.add(Number(match[1]));
  }
  const patch = [...patches][0];
  if (patches.size !== 1 || patch === undefined)
    throw new HermesInstallError(HERMES_INSTALL_FAILED);
  return `3.13.${patch}`;
}

function uvEnvironment(
  root: string,
  versionDir: string,
  home: string,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    UV_PYTHON_INSTALL_DIR: path.join(root, "runtimes", "python"),
    UV_PYTHON_PREFERENCE: "only-managed",
    UV_NO_CONFIG: "1",
    UV_CACHE_DIR: path.join(root, "runtimes", ".uv-cache"),
    UV_PROJECT_ENVIRONMENT: path.join(versionDir, ".venv"),
  };
  for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] as const) {
    const value = inherited[key];
    if (typeof value === "string" && value.length > 0 && !/[\r\n\0]/.test(value)) env[key] = value;
  }
  return env;
}

async function runChecked(
  run: HermesCommand,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; log: string },
): Promise<void> {
  const result = await run(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  await appendLog(options.log, `$ uv ${args.join(" ")}\n${result.stdout}\n${result.stderr}\n`);
  if (result.code !== 0) throw new HermesInstallError(HERMES_INSTALL_FAILED);
}

async function appendLog(file: string, text: string): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = "";
  }
  await writeFile(file, (existing + text).slice(-LOG_BYTES), { mode: 0o600 });
}

async function download(
  start: string,
  fetchImpl: HermesFetch | undefined,
  limit: number,
  timeoutMs: number,
): Promise<Buffer> {
  const request =
    fetchImpl ??
    ((input: string, init?: { redirect?: "manual"; signal?: AbortSignal }) => fetch(input, init));
  let current = start;
  for (let hop = 0; hop <= 5; hop += 1) {
    assertFetchUrl(current);
    let response: Response;
    try {
      response = await request(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new HermesInstallError(HERMES_INSTALL_FAILED);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new HermesInstallError(HERMES_INSTALL_FAILED);
      current = new URL(location, current).toString();
      continue;
    }
    if (response.status !== 200) throw new HermesInstallError(HERMES_INSTALL_FAILED);
    return readBody(response, limit);
  }
  throw new HermesInstallError(HERMES_INSTALL_FAILED);
}

function assertFetchUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HermesInstallError(HERMES_INSTALL_FAILED);
  }
  if (url.protocol !== "https:") throw new HermesInstallError(HERMES_INSTALL_FAILED);
  if (url.username !== "" || url.password !== "")
    throw new HermesInstallError(HERMES_INSTALL_FAILED);
  if (url.port !== "" && url.port !== "443") throw new HermesInstallError(HERMES_INSTALL_FAILED);
  if (!ALLOWED_HOSTS.has(url.hostname)) throw new HermesInstallError(HERMES_INSTALL_FAILED);
}

async function readBody(response: Response, limit: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new HermesInstallError(HERMES_INSTALL_FAILED);
  if (!response.body) throw new HermesInstallError(HERMES_INSTALL_FAILED);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new HermesInstallError(HERMES_INSTALL_FAILED);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HermesInstallError) throw error;
    throw new HermesInstallError(HERMES_INSTALL_FAILED);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function defaultCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-LOG_BYTES);
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-LOG_BYTES);
  });
  const code = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      if (child.pid !== undefined && child.exitCode === null) {
        try {
          process.kill(child.pid, "SIGTERM");
        } catch {
          // The child already exited.
        }
        const kill = setTimeout(() => {
          if (child.pid !== undefined && child.exitCode === null) {
            try {
              process.kill(child.pid, "SIGKILL");
            } catch {
              // The child already exited.
            }
          }
        }, 1000);
        kill.unref();
      }
    }, options.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(1);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve(status ?? 1);
    });
  });
  return { code, stdout, stderr };
}
