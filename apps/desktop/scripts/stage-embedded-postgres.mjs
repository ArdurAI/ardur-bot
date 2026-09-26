import { existsSync, readFileSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * electron-builder's `${platform}` macro expands to darwin, linux, or win32
 * (https://www.electron.build/file-patterns). The Postgres packages are named
 * `@embedded-postgres/windows-x64`, not `win32-x64`, so each packaging run copies
 * only its own optional platform package into extraResources. The wrapper
 * package is not copied; its optional dependencies would otherwise ship every
 * architecture.
 *
 * npm cannot store the binaries' symlinks. The package lists them in
 * `native/pg-symlinks.json` and a postinstall recreates them, but a package
 * cache can hold them as plain copies. Staging keeps relative links relative and
 * recreates every listed link, so the libraries ship once and resolve wherever
 * the app is installed. electron-builder copies extraResources links as they are.
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

function installedRoot(require, name) {
  try {
    return packageRoot(require, name);
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") throw error;
    return null;
  }
}

function resolveEmbeddedPostgresRoot(desktopDir, packageName) {
  const desktopRequire = createRequire(path.join(desktopDir, "package.json"));
  const direct = installedRoot(desktopRequire, packageName);
  if (direct) return direct;
  const wrapperRoot = installedRoot(desktopRequire, "embedded-postgres");
  if (!wrapperRoot) return null;
  const nested = path.join(path.dirname(wrapperRoot), ...packageName.split("/"));
  if (existsSync(path.join(nested, "package.json"))) return nested;
  return installedRoot(createRequire(path.join(wrapperRoot, "package.json")), packageName);
}

function assertPackageMatches(source, platform, arch) {
  const manifest = JSON.parse(readFileSync(path.join(source, "package.json"), "utf8"));
  const expected = embeddedPostgresPackageName(platform, arch);
  const cpus = Array.isArray(manifest.cpu) ? manifest.cpu : [];
  const systems = Array.isArray(manifest.os) ? manifest.os : [];
  if (
    manifest.name !== expected ||
    (cpus.length > 0 && !cpus.includes(arch)) ||
    (systems.length > 0 && !systems.includes(platform))
  ) {
    throw new Error(
      `Refusing to stage ${manifest.name ?? "an unknown package"} for ${platform} ${arch}.`,
    );
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Replaces every link the package lists, whether it arrived as a link or as a copy. */
async function linkLibraries(root) {
  let links;
  try {
    links = JSON.parse(await readFile(path.join(root, "native", "pg-symlinks.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const { source, target } of links) {
    const from = path.resolve(root, source);
    const to = path.resolve(root, target);
    if (!inside(root, from) || !inside(root, to)) {
      throw new Error(`The Postgres link ${target} points outside the package.`);
    }
    await stat(from);
    await rm(to, { force: true });
    await symlink(path.relative(path.dirname(to), from), to);
  }
}

/** A link that is absolute or leaves the staged folder would break once the app is installed. */
async function assertLinksStayInside(root, dir = root, realRoot = undefined) {
  const base = realRoot ?? (await realpath(root));
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await assertLinksStayInside(root, file, base);
      continue;
    }
    if (!entry.isSymbolicLink()) continue;
    const value = await readlink(file);
    const resolved = await realpath(file).catch(() => null);
    if (path.isAbsolute(value) || resolved === null || !inside(base, resolved)) {
      throw new Error(`The Postgres link ${path.relative(root, file)} points outside the package.`);
    }
  }
}

export async function stageEmbeddedPostgres(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const desktopDir = options.desktopDir ?? fileURLToPath(new URL("..", import.meta.url));
  const stagedRoot = path.join(desktopDir, "build", "postgres-modules");
  // A folder left by another platform or arch must never be packed by mistake.
  await rm(stagedRoot, { recursive: true, force: true });
  const packageName = embeddedPostgresPackageName(platform, arch);
  const found = resolveEmbeddedPostgresRoot(desktopDir, packageName);
  if (!found) throw new Error(`Cannot find ${packageName} to stage beside the desktop app.`);
  // pnpm links the package folder itself; copy what it points at.
  const source = await realpath(found);
  assertPackageMatches(source, platform, arch);
  const destination = path.join(stagedRoot, ...packageName.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, verbatimSymlinks: true });
  await linkLibraries(destination);
  await assertLinksStayInside(destination);
  const binary = path.join(
    destination,
    "native",
    "bin",
    platform === "win32" ? "postgres.exe" : "postgres",
  );
  if (!(await lstat(binary)).isFile()) throw new Error(`${packageName} has no postgres binary.`);
  return { packageName, source, destination, binary };
}

/** electron-builder `beforePack`: runs for every platform and arch it packs, before extraResources. */
export default async function beforePack(context) {
  // Loaded here so the command line does not pay for electron-builder.
  const { Arch } = await import("electron-builder");
  await stageEmbeddedPostgres({
    platform: context.electronPlatformName,
    arch: Arch[context.arch],
    desktopDir: context.packager.projectDir,
  });
}

function cliOptions(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--platform" && flag !== "--arch" && flag !== "--desktop") {
      throw new Error(`Unknown argument ${flag}.`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = cliOptions(process.argv);
  const staged = await stageEmbeddedPostgres({
    platform: options.platform,
    arch: options.arch,
    desktopDir: options.desktop,
  });
  process.stdout.write(`Staged ${staged.packageName} at ${staged.destination}\n`);
}
