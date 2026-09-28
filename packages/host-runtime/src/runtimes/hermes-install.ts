import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const sourceHashes = {
  "acp_adapter/session.py": "423f9b8b065600607dced5185ce58cd60d2fe450844caf6ce6229c3b7ceeb835",
  "acp_adapter/server.py": "5ebbbda6511a692faeaf8f57e0ad88182bf22c2d818d16c94f1e95516bb7375d",
  "acp_adapter/entry.py": "b70e7b189e36644d60576bc1acdc929ae4bd16c80022d5e2b7a8dec97b24d383",
  "run_agent.py": "5b2e7083680e6c728f2306adc73e5f814c444aaa9ff3e3b840206142c67a7149",
  "pyproject.toml": "c70c8b52f6cc08a4e65f0fc1713c26814fd4f19811bc7e01de645009b2a76600",
  "uv.lock": "383cd8f98ec23dc3fe4cf63759ec73be5a869cc953f068b4e79ec4e8ed00287d",
} as const;

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
  const bundled = hermesLauncherAsset(bundleFile);
  if (existsSync(bundled)) return bundled;
  try {
    if (moduleUrl) {
      const source = path.resolve(
        path.dirname(fileURLToPath(moduleUrl)),
        "../python/hermes_launcher.py",
      );
      if (existsSync(source)) return source;
    }
  } catch {
    // Bundled builds may have no module URL. A missing asset always fails closed.
  }
  throw new Error("Pinned Hermes launcher is unavailable.");
}

/** Native execution has host authority; qualification and the broker remain mandatory. */
export function pinnedHermesLaunch(install: string, launcher: string): HermesLaunch {
  return async (spec: HermesLaunchSpec) => {
    const qualified = probeHermesInstall(install);
    if (!existsSync(launcher) || spec.command !== qualified.python || spec.args[0] !== launcher)
      throw new Error("Pinned Hermes launcher is unavailable.");
    const child = spawn(qualified.python, ["-B", launcher], {
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
