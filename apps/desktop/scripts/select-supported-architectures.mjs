import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pnpm 9 installs optional dependencies only for the current os/cpu unless
 * package.json sets pnpm.supportedArchitectures. The release job that builds
 * macOS x64 on an arm64 runner needs the x64 Postgres package present.
 * https://pnpm.io/settings#supportedarchitectures
 * https://github.com/pnpm/pnpm/blob/v9.15.0/config/config/src/getOptionsFromRootManifest.ts
 */
export function supportedArchitectures(osName, cpu) {
  if (!osName || !cpu) throw new Error("Pass --os and --cpu for the installer architecture.");
  return {
    os: [...new Set(["current", osName])],
    cpu: [...new Set(["current", cpu])],
    libc: ["current"],
  };
}

export function applySupportedArchitectures(manifest, osName, cpu) {
  return {
    ...manifest,
    pnpm: {
      ...manifest.pnpm,
      supportedArchitectures: supportedArchitectures(osName, cpu),
    },
  };
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = flag("--root") ?? process.cwd();
  const manifestPath = path.join(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const next = applySupportedArchitectures(manifest, flag("--os"), flag("--cpu"));
  writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}
