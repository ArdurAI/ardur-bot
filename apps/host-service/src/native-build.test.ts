import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Build script is intentionally JavaScript.
import { stageDarwinPty, stageWindowsNativeAddons } from "../build.mjs";

let directory: string;
let koffiEntry: string;
let output: string;
async function fixtureFile(relative: string, contents: string) {
  const file = path.join(directory, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  return file;
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "host-native-build-"));
  koffiEntry = await fixtureFile("node_modules/koffi/index.cjs", "");
  output = path.join(directory, "dist");
});
afterEach(async () => rm(directory, { recursive: true, force: true }));

describe("macOS PTY staging", () => {
  async function ptyFixture() {
    await fixtureFile("node-pty/package.json", JSON.stringify({ version: "1.1.0" }));
    await fixtureFile("node-pty/LICENSE", "MIT fixture");
    for (const name of ["index", "unixTerminal", "terminal", "eventEmitter2", "utils"])
      await fixtureFile(`node-pty/lib/${name}.js`, `fixture-${name}`);
    for (const arch of ["arm64", "x64"])
      for (const name of ["pty.node", "spawn-helper"])
        await fixtureFile(`node-pty/prebuilds/darwin-${arch}/${name}`, `fixture-${arch}-${name}`);
    await fixtureFile("node-pty/prebuilds/linux-x64/pty.node", "excluded");
    return path.join(directory, "node-pty/lib/index.js");
  }
  it("stages the pinned loader, license and both macOS prebuilds with an executable helper", async () => {
    const entry = await ptyFixture();
    const staged = await stageDarwinPty(output, entry);
    expect(staged.files).toHaveLength(18);
    expect((await readdir(path.join(output, "native"))).sort()).toEqual(["mac_arm64", "mac_x64"]);
    for (const arch of ["arm64", "x64"]) {
      const root = path.join(output, "native", `mac_${arch}`, "node-pty");
      const helper = path.join(root, "prebuilds", `darwin-${arch}`, "spawn-helper");
      expect(await readFile(helper, "utf8")).toBe(`fixture-${arch}-spawn-helper`);
      expect((await stat(helper)).mode & 0o111).toBe(0o111);
      expect(JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))).toMatchObject({
        version: "1.1.0",
        main: "lib/index.js",
      });
      expect(await readdir(path.join(root, "prebuilds"))).toEqual([`darwin-${arch}`]);
    }
  });
  it("clears stale PTY files without removing the other native platform", async () => {
    const entry = await ptyFixture();
    await fixtureFile("dist/native/mac_arm64/node-pty/stale.node", "old");
    await fixtureFile("dist/native/win_x64/koffi.node", "keep");
    await stageDarwinPty(output, entry);
    await expect(
      stat(path.join(output, "native/mac_arm64/node-pty/stale.node")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(output, "native/win_x64/koffi.node"), "utf8")).toBe("keep");
  });
  it("fails on a missing macOS prebuild instead of producing an incomplete package", async () => {
    const entry = await ptyFixture();
    await rm(path.join(directory, "node-pty/prebuilds/darwin-x64/spawn-helper"));
    await expect(stageDarwinPty(output, entry)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("Windows native staging", () => {
  it("copies each installed Windows prebuild byte for byte and excludes macOS and Linux", async () => {
    for (const platform of ["win32", "darwin", "linux"])
      for (const arch of ["x64", "arm64", "ia32"])
        await fixtureFile(
          `node_modules/@koromix/koffi-${platform}-${arch}/${platform}_${arch}/koffi.node`,
          `${platform}-${arch}-fixture`,
        );
    const result = await stageWindowsNativeAddons(output, koffiEntry);
    expect(result.skipped).toEqual([]);
    expect((await readdir(path.join(output, "native"))).sort()).toEqual([
      "win_arm64",
      "win_ia32",
      "win_x64",
    ]);
    for (const arch of ["x64", "arm64", "ia32"]) {
      const relative = `native/win_${arch}/koffi.node`;
      expect(result.files).toContain(relative);
      expect(await readFile(path.join(output, relative), "utf8")).toBe(`win32-${arch}-fixture`);
      expect(await readdir(path.join(output, "native", `win_${arch}`))).toEqual(["koffi.node"]);
    }
  });

  it("supports koffi's local build layout when the split package is absent", async () => {
    await fixtureFile("node_modules/koffi/build/koffi/win32_x64/koffi.node", "local-prebuild");
    const result = await stageWindowsNativeAddons(output, koffiEntry);
    expect(result.files).toEqual(["native/win_x64/koffi.node"]);
    expect(result.skipped).toHaveLength(2);
    expect(await readFile(path.join(output, result.files[0]), "utf8")).toBe("local-prebuild");
  });

  it("removes stale addons and reports why a target has no binary", async () => {
    const binary = await fixtureFile(
      "node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node",
      "old-prebuild",
    );
    await stageWindowsNativeAddons(output, koffiEntry);
    await rm(binary);
    const result = await stageWindowsNativeAddons(output, koffiEntry);
    expect(result.files).toEqual([]);
    expect(result.skipped.map(({ target }: { target: string }) => target)).toEqual([
      "win32_x64",
      "win32_arm64",
      "win32_ia32",
    ]);
    expect(result.skipped[0].reason).toContain("Windows writes remain refused");
    await expect(readdir(path.join(output, "native"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
