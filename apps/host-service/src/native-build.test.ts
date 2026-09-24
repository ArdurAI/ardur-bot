import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error Build script is intentionally JavaScript.
import { stageWindowsNativeAddons } from "../build.mjs";

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
