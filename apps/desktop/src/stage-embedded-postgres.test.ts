import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Arch } from "electron-builder";
import { afterEach, describe, expect, it } from "vitest";
import beforePack from "../scripts/stage-embedded-postgres.mjs";

const script = path.resolve(import.meta.dirname, "../scripts/stage-embedded-postgres.mjs");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LIBRARY = "L".repeat(64 * 1024);

/**
 * A platform package as a package cache can hold it: one listed link still a relative
 * symlink, and one materialized as a plain copy of the library it names. pnpm keeps it
 * in its store and links it beside the `embedded-postgres` wrapper that depends on it.
 */
function fakePackage(root: string, name: string, cpu: string) {
  const dir = path.join(root, "store", name.replace("/", "+"), ...name.split("/"));
  const linked = path.join(wrapperModules(root), ...name.split("/"));
  mkdirSync(path.dirname(linked), { recursive: true });
  mkdirSync(path.join(dir, "native", "bin"), { recursive: true });
  mkdirSync(path.join(dir, "native", "lib"), { recursive: true });
  symlinkSync(path.relative(path.dirname(linked), dir), linked);
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name, os: ["darwin"], cpu: [cpu] }),
  );
  writeFileSync(path.join(dir, "native", "bin", "postgres"), "fixture-binary");
  writeFileSync(path.join(dir, "native", "lib", "libicu.68.2.dylib"), LIBRARY);
  symlinkSync("libicu.68.2.dylib", path.join(dir, "native", "lib", "libicu.dylib"));
  writeFileSync(path.join(dir, "native", "lib", "libz.1.3.dylib"), LIBRARY);
  writeFileSync(path.join(dir, "native", "lib", "libz.dylib"), LIBRARY);
  writeFileSync(
    path.join(dir, "native", "pg-symlinks.json"),
    JSON.stringify([
      { source: "native/lib/libicu.68.2.dylib", target: "native/lib/libicu.dylib" },
      { source: "native/lib/libz.1.3.dylib", target: "native/lib/libz.dylib" },
    ]),
  );
}

function wrapperModules(root: string) {
  return path.join(root, "store", "embedded-postgres", "node_modules");
}

function fakeDesktop() {
  const root = mkdtempSync(path.join(tmpdir(), "stage-postgres-"));
  roots.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fake-desktop" }));
  const wrapper = path.join(wrapperModules(root), "embedded-postgres");
  mkdirSync(wrapper, { recursive: true });
  writeFileSync(path.join(wrapper, "package.json"), JSON.stringify({ name: "embedded-postgres" }));
  mkdirSync(path.join(root, "node_modules"), { recursive: true });
  symlinkSync(
    path.relative(path.join(root, "node_modules"), wrapper),
    path.join(root, "node_modules", "embedded-postgres"),
  );
  fakePackage(root, "@embedded-postgres/darwin-x64", "x64");
  fakePackage(root, "@embedded-postgres/darwin-arm64", "arm64");
  return root;
}

function run(root: string, args: string[]) {
  // pnpm exec sets NODE_PATH to its hoisted store, which would find the real packages.
  const { NODE_PATH: _hoisted, ...env } = process.env;
  return spawnSync(process.execPath, [script, "--desktop", root, ...args], {
    encoding: "utf8",
    env,
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}

describe("stage embedded postgres", () => {
  it("ships each library once, as links that still resolve after the folder moves", () => {
    const root = fakeDesktop();
    const result = run(root, ["--platform", "darwin", "--arch", "arm64"]);
    expect(result.status, result.stderr).toBe(0);

    // Installing moves the staged folder, and the build checkout is gone on a person's computer.
    const installed = path.join(root, "installed");
    renameSync(path.join(root, "build", "postgres-modules"), installed);
    rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
    rmSync(path.join(root, "store"), { recursive: true, force: true });

    const files = walk(installed);
    const links = files.filter((file) => lstatSync(file).isSymbolicLink());
    expect(links.map((file) => path.basename(file)).sort()).toEqual(["libicu.dylib", "libz.dylib"]);
    const realInstalled = realpathSync(installed);
    for (const link of links) {
      expect(path.isAbsolute(readlinkSync(link))).toBe(false);
      const target = realpathSync(link);
      expect(path.relative(realInstalled, target).startsWith("..")).toBe(false);
      expect(readFileSync(link, "utf8")).toBe(LIBRARY);
    }
    const libraryBytes = files
      .filter((file) => file.includes(`${path.sep}lib${path.sep}`) && lstatSync(file).isFile())
      .reduce((total, file) => total + lstatSync(file).size, 0);
    expect(libraryBytes).toBe(2 * LIBRARY.length);
    expect(
      existsSync(path.join(installed, "@embedded-postgres", "darwin-arm64", "native", "bin")),
    ).toBe(true);
    expect(existsSync(path.join(installed, "@embedded-postgres", "darwin-x64"))).toBe(false);
  });

  it("clears a folder staged for another architecture before staging this one", () => {
    const root = fakeDesktop();
    expect(run(root, ["--platform", "darwin", "--arch", "x64"]).status).toBe(0);
    expect(run(root, ["--platform", "darwin", "--arch", "arm64"]).status).toBe(0);
    expect(readdirSync(path.join(root, "build", "postgres-modules", "@embedded-postgres"))).toEqual(
      ["darwin-arm64"],
    );
  });

  it("refuses to stage a package whose cpu does not match --arch", () => {
    const root = fakeDesktop();
    const dir = path.join(
      root,
      "store",
      "@embedded-postgres+darwin-x64",
      "@embedded-postgres",
      "darwin-x64",
    );
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "@embedded-postgres/darwin-x64", os: ["darwin"], cpu: ["arm64"] }),
    );
    const result = run(root, ["--platform", "darwin", "--arch", "x64"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Refusing to stage/);
  });

  it("fails, leaving nothing staged, when this platform's package is not installed", () => {
    const root = fakeDesktop();
    expect(run(root, ["--platform", "darwin", "--arch", "arm64"]).status).toBe(0);
    const result = run(root, ["--platform", "linux", "--arch", "x64"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Cannot find @embedded-postgres\/linux-x64/);
    expect(existsSync(path.join(root, "build", "postgres-modules"))).toBe(false);
  });

  it("stages for each platform and arch electron-builder packs, and fails the pack without it", async () => {
    const root = fakeDesktop();
    // Found before anything NODE_PATH lists, since this runs in the test process.
    const direct = path.join(root, "node_modules", "@embedded-postgres", "darwin-x64");
    mkdirSync(path.dirname(direct), { recursive: true });
    symlinkSync(
      path.join(root, "store", "@embedded-postgres+darwin-x64", "@embedded-postgres", "darwin-x64"),
      direct,
    );
    const packager = { projectDir: root };
    await beforePack({ electronPlatformName: "darwin", arch: Arch.x64, packager });
    expect(readdirSync(path.join(root, "build", "postgres-modules", "@embedded-postgres"))).toEqual(
      ["darwin-x64"],
    );
    await expect(
      beforePack({ electronPlatformName: "win32", arch: Arch.x64, packager }),
    ).rejects.toThrow("Cannot find @embedded-postgres/windows-x64");
    expect(existsSync(path.join(root, "build", "postgres-modules"))).toBe(false);
  });
});
