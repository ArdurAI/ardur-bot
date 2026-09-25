import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * electron-builder's `${platform}` macro expands to darwin, linux, or win32
 * (https://www.electron.build/file-patterns). The Postgres packages are named
 * `@embedded-postgres/windows-x64`, not `win32-x64`, so each release job copies
 * only its own optional platform package into extraResources. The wrapper
 * package is not copied; its optional dependencies would otherwise ship every
 * architecture. npm cannot store the binaries' symlinks, so the wrapper
 * postinstall must already have recreated them before this copy.
 */
const PACKAGES = {
  "darwin-arm64": "@embedded-postgres/darwin-arm64",
  "darwin-x64": "@embedded-postgres/darwin-x64",
  "linux-x64": "@embedded-postgres/linux-x64",
  "linux-arm64": "@embedded-postgres/linux-arm64",
  "win32-x64": "@embedded-postgres/windows-x64",
};

export function embeddedPostgresPackageName(platform, arch) {
  const name = PACKAGES[`${platform}-${arch}`];
  if (!name) throw new Error(`No embedded Postgres binary for ${platform} ${arch}.`);
  return name;
}

export function stagePlan(platform, arch) {
  const packageName = embeddedPostgresPackageName(platform, arch);
  return {
    packageName,
    from: "build/postgres-modules",
    to: "postgres-modules",
    destination: path.join("build", "postgres-modules", packageName),
  };
}

function packageRoot(require, name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch (error) {
    if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
  }
  let dir = path.dirname(require.resolve(name));
  while (dir !== path.dirname(dir)) {
    const manifestPath = path.join(dir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === name) return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

function resolveEmbeddedPostgresRoot(desktopDir, packageName) {
  const desktopRequire = createRequire(path.join(desktopDir, "package.json"));
  try {
    const direct = packageRoot(desktopRequire, packageName);
    if (direct) return direct;
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
  }
  const wrapperRoot = packageRoot(desktopRequire, "embedded-postgres");
  if (!wrapperRoot) {
    throw new Error(`Cannot find ${packageName} to stage beside the desktop app.`);
  }
  const nested = path.join(path.dirname(wrapperRoot), ...packageName.split("/"));
  if (existsSync(path.join(nested, "package.json"))) return nested;
  return packageRoot(createRequire(path.join(wrapperRoot, "package.json")), packageName);
}

export async function stageEmbeddedPostgres(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const desktopDir = options.desktopDir ?? fileURLToPath(new URL("..", import.meta.url));
  const plan = stagePlan(platform, arch);
  const source = resolveEmbeddedPostgresRoot(desktopDir, plan.packageName);
  if (!source) throw new Error(`Cannot find ${plan.packageName} to stage beside the desktop app.`);
  const destination = path.join(desktopDir, plan.destination);
  await rm(path.join(desktopDir, "build", "postgres-modules"), { recursive: true, force: true });
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, verbatimSymlinks: false });
  const binaryName = process.platform === "win32" ? "postgres.exe" : "postgres";
  const binary = path.join(destination, "native", "bin", binaryName);
  await stat(binary);
  return { ...plan, source, destination, binary };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const staged = await stageEmbeddedPostgres();
  process.stdout.write(`Staged ${staged.packageName} at ${staged.destination}\n`);
}
