import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sourceHashes from "../../python/hermes_sources.json" with { type: "json" };
import {
  type HostGuardrailConfig,
  resolveGuardrailPathsSync,
  seatbeltArgv,
  seatbeltProfile,
} from "../host-guardrails.js";
import type { HermesLaunch, HermesLaunchSpec } from "./hermes-runtime.js";
import { stopNative } from "./native-process.js";

export const HERMES_SOURCE_PIN = "29112bef099274229cadff79cdff7bf7b99c4b77";
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
  if (process.platform === "win32" || !path.isAbsolute(root))
    throw new Error("Pinned Hermes is unavailable on this host.");
  const install = existsSync(root) ? realpathSync(root) : path.resolve(root);
  const python = path.join(install, ".venv", "bin", "python");
  if (existsSync(path.join(install, ".env")) || !existsSync(python))
    throw new Error("Pinned Hermes install failed its safety check.");
  try {
    if (!statSync(python).isFile()) throw new Error("Interpreter is unavailable.");
    for (const [relative, expected] of Object.entries(sourceHashes)) {
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
  try {
    if (moduleUrl) {
      const source = path.resolve(
        path.dirname(fileURLToPath(moduleUrl)),
        "../python/hermes_launcher.py",
      );
      if (existsSync(source) && complete(source)) return source;
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
  if (platform !== "darwin" || !guard || (!guard.paths.length && !guard.ports.length))
    return [python, "-B", launcher];
  return seatbeltArgv(
    [python, "-B", launcher],
    seatbeltProfile({ paths: resolveGuardrailPathsSync(guard.paths), ports: guard.ports }),
  );
}
