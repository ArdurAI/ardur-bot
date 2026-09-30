import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HermesExecutionEnvelopeSchema } from "@ardurbot/contracts/runtime-config";
import type * as z from "zod";
import sourceHashes from "../../python/hermes_sources.json" with { type: "json" };
import {
  type HostGuardrailConfig,
  resolveGuardrailPathsSync,
  seatbeltArgv,
  seatbeltProfile,
} from "../host-guardrails.js";
import { type HermesLaunch, type HermesLaunchSpec, HermesRuntime } from "./hermes-runtime.js";
import { stopNative } from "./native-process.js";

export const HERMES_SOURCE_PIN = "29112bef099274229cadff79cdff7bf7b99c4b77";
/** Git tree of HERMES_SOURCE_PIN. A managed archive has no commit, so the marker records this. */
export const HERMES_SOURCE_TREE = "daaffc303ae437041b7f76be17c5f61b14f2ce99";

export function localHermesRoot(): string {
  return path.join(path.resolve(process.env.DATA_DIR ?? "./data"), "hermes");
}

export function localHermesStaging(): string {
  return path.join(localHermesRoot(), "staging");
}

export function localHermesInstallCandidate(): string | null {
  return hermesInstallCandidate(localHermesStaging(), process.env.ARDUR_HERMES_INSTALL);
}

/** The workspace root is supplied by the trusted host configuration, never a bot request. */
export function hermesInstallCandidate(
  hostRoot: string,
  explicit: string | undefined,
): string | null {
  if (explicit) return explicit;
  const managed = path.join(path.dirname(hostRoot), "runtimes", "hermes-agent");
  return existsSync(managed) ? managed : null;
}
/** Only the trusted explicit or managed install can qualify. Never probe a personal home or PATH. */
export function probeHermesInstall(root: string): { python: string; root: string } {
  return qualifyHermesInstall(root);
}

/**
 * Accept a git checkout whose HEAD is the pin, or a managed archive with no `.git`
 * whose marker records that pin and tree. File hashes stay mandatory either way.
 * `git` runs only when this directory itself has `.git`, so a parent repo cannot qualify it.
 */
export function qualifyHermesInstall(
  root: string,
  options?: { pin?: string; tree?: string; sources?: Record<string, string> },
): { python: string; root: string } {
  if (process.platform === "win32" || !path.isAbsolute(root))
    throw new Error("Pinned Hermes is unavailable on this host.");
  const install = existsSync(root) ? realpathSync(root) : path.resolve(root);
  const python = path.join(install, ".venv", "bin", "python");
  if (existsSync(path.join(install, ".env")) || !existsSync(python))
    throw new Error("Pinned Hermes install failed its safety check.");
  const pin = options?.pin ?? HERMES_SOURCE_PIN;
  const tree = options?.tree ?? HERMES_SOURCE_TREE;
  const sources = options?.sources ?? sourceHashes;
  try {
    if (!statSync(python).isFile()) throw new Error("Interpreter is unavailable.");
    assertHermesIdentity(install, pin, tree);
    for (const [relative, expected] of Object.entries(sources)) {
      const actual = createHash("sha256")
        .update(readFileSync(path.join(install, relative)))
        .digest("hex");
      if (actual !== expected) throw new Error("Pinned source changed.");
    }
  } catch {
    throw new Error("Pinned Hermes install failed its provenance check.");
  }
  return { python, root: install };
}

function hasGitMetadata(install: string): boolean {
  try {
    lstatSync(path.join(install, ".git"));
    return true;
  } catch {
    return false;
  }
}

function assertHermesIdentity(install: string, pin: string, tree: string): void {
  if (hasGitMetadata(install)) {
    const result = spawnSync("git", ["-C", install, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const revision =
      result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : "";
    if (revision !== pin) throw new Error("Install revision changed.");
    return;
  }
  const marker = JSON.parse(readFileSync(path.join(install, ".ardur-install.json"), "utf8")) as {
    pin?: unknown;
    tree?: unknown;
  };
  if (!marker || typeof marker !== "object" || marker.pin !== pin || marker.tree !== tree)
    throw new Error("Install marker mismatch.");
}

export const HERMES_INSTALL_PHASES = [
  "downloading",
  "checking",
  "python",
  "packages",
  "finishing",
] as const;
export type HermesInstallPhase = (typeof HERMES_INSTALL_PHASES)[number];
export type HermesInstallRunState = "installing" | "ready" | "failed";

export type HermesInstallStatus = {
  state: HermesInstallRunState;
  phase?: HermesInstallPhase;
  message: string;
  updatedAt: string;
};

export function hermesInstallStatusPath(root: string): string {
  return path.join(root, "install-status.json");
}

export function hermesInstallLockPath(root: string): string {
  return path.join(root, "runtimes", ".install.lock");
}

export function readHermesInstallStatus(root: string): HermesInstallStatus | null {
  try {
    const parsed = JSON.parse(readFileSync(hermesInstallStatusPath(root), "utf8")) as {
      state?: unknown;
      phase?: unknown;
      message?: unknown;
      updatedAt?: unknown;
    };
    if (parsed.state !== "installing" && parsed.state !== "ready" && parsed.state !== "failed")
      return null;
    if (
      parsed.phase !== undefined &&
      !HERMES_INSTALL_PHASES.includes(parsed.phase as HermesInstallPhase)
    )
      return null;
    if (typeof parsed.message !== "string" || typeof parsed.updatedAt !== "string") return null;
    return {
      state: parsed.state,
      ...(parsed.phase ? { phase: parsed.phase as HermesInstallPhase } : {}),
      message: parsed.message,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * A lock is stale only when its recorded pid is gone (ESRCH); EPERM still counts as
 * running, so a live installer is never stolen from whatever its age. A lock that
 * exists but cannot be parsed counts as held.
 */
export function hermesInstallLockHeld(root: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(hermesInstallLockPath(root), "utf8")) as {
      pid?: unknown;
    };
    const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
    if (pid === undefined) return true;
    return hermesInstallPidAlive(pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export type HermesInstallView =
  | { state: "installing"; phase: HermesInstallPhase }
  | { state: "ready" }
  | { state: "failed" };

/** Progress for a local install. A manual checkout with no status file stays omitted. */
export function hermesInstallProgress(root: string): HermesInstallView | null {
  const status = readHermesInstallStatus(root);
  if (!status) return null;
  if (status.state === "installing") {
    if (!hermesInstallLockHeld(root)) return { state: "failed" };
    return { state: "installing", phase: status.phase ?? "downloading" };
  }
  if (status.state === "ready") return { state: "ready" };
  return { state: "failed" };
}

/** A recorded process id counts as running when it exists; EPERM still counts as running. */
export function hermesInstallPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function hermesLauncherAsset(bundleFile: string): string {
  return path.join(path.dirname(bundleFile), "python", "hermes_launcher.py");
}

export function resolveHermesLauncherAsset(
  bundleFile: string,
  moduleUrl: string | undefined,
): string {
  const complete = (launcher: string) =>
    ["hermes_profile.py", "hermes_sources.json", "runtime_config_profile.json"].every((name) =>
      existsSync(path.join(path.dirname(launcher), name)),
    );
  const bundled = hermesLauncherAsset(bundleFile);
  if (existsSync(bundled) && complete(bundled)) return bundled;
  const desktopBundled = path.resolve(
    path.dirname(bundleFile),
    "../host-service/python/hermes_launcher.py",
  );
  if (existsSync(desktopBundled) && complete(desktopBundled)) return desktopBundled;
  try {
    if (moduleUrl) {
      const source = path.resolve(
        path.dirname(fileURLToPath(moduleUrl)),
        "../python/hermes_launcher.py",
      );
      if (existsSync(source) && complete(source)) return source;
      const workerDevSource = path.resolve(
        path.dirname(fileURLToPath(moduleUrl)),
        "../../../host-runtime/python/hermes_launcher.py",
      );
      if (existsSync(workerDevSource) && complete(workerDevSource)) return workerDevSource;
    }
  } catch {
    // Bundled builds may have no module URL. A missing asset always fails closed.
  }
  throw new Error("Pinned Hermes launcher is unavailable.");
}

/** Native execution has host authority; qualification and the broker remain mandatory. */
export function pinnedHermesLaunch(
  install: string,
  launcher: string,
  guard?: HostGuardrailConfig,
): HermesLaunch {
  return async (spec: HermesLaunchSpec) => {
    const qualified = probeHermesInstall(install);
    if (!existsSync(launcher) || spec.command !== qualified.python || spec.args[0] !== launcher)
      throw new Error("Pinned Hermes launcher is unavailable.");
    const argv = hermesLaunchArgv(qualified.python, launcher, guard);
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: spec.cwd,
      env: {
        ...spec.env,
        PYTHONDONTWRITEBYTECODE: "1",
        ARDUR_HERMES_INSTALL: qualified.root,
      },
      shell: false,
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32" && !process.send,
    });
    return { child, teardown: async () => stopNative(child) };
  };
}

/**
 * Hermes' own terminal/files/code tools run inside this process with host authority, so the
 * process itself runs under the host command guardrail on macOS; other platforms return the
 * launch unchanged. A profile that cannot be built throws — the turn fails closed.
 */
export function hermesLaunchArgv(
  python: string,
  launcher: string,
  guard?: HostGuardrailConfig,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (
    platform !== "darwin" ||
    !guard ||
    (!guard.paths.length && !guard.ports.length && !guard.sockets.length)
  )
    return [python, "-B", launcher];
  return seatbeltArgv(
    [python, "-B", launcher],
    seatbeltProfile({
      paths: resolveGuardrailPathsSync(guard.paths),
      ports: guard.ports,
      sockets: resolveGuardrailPathsSync(guard.sockets),
    }),
  );
}

export async function buildHermesRuntime(options: {
  hostRoot: string;
  explicitInstall?: string;
  bundleFile: string;
  moduleUrl: string | undefined;
  guard?: HostGuardrailConfig;
  executionEnvelope?: z.infer<typeof HermesExecutionEnvelopeSchema>;
  onProfileAcknowledged: () => void;
  onTurnFinished: () => void;
}): Promise<HermesRuntime | null> {
  const install = hermesInstallCandidate(options.hostRoot, options.explicitInstall);
  if (!install) return null;
  const qualified = probeHermesInstall(install);
  await mkdir(options.hostRoot, { recursive: true, mode: 0o700 });
  const staging = await realpath(options.hostRoot);
  const overlap = path.relative(qualified.root, staging);
  if (
    overlap === "" ||
    (overlap !== ".." && !overlap.startsWith(`..${path.sep}`) && !path.isAbsolute(overlap))
  )
    throw new Error("Hermes staging cannot overlap its install.");
  const launcher = resolveHermesLauncherAsset(options.bundleFile, options.moduleUrl);
  return new HermesRuntime({
    command: qualified.python,
    args: [launcher],
    launch: pinnedHermesLaunch(qualified.root, launcher, options.guard),
    pinned: true,
    executionEnvelope: options.executionEnvelope,
    onProfileAcknowledged: options.onProfileAcknowledged,
    stagingParent: options.hostRoot,
    onTurnFinished: options.onTurnFinished,
  });
}
