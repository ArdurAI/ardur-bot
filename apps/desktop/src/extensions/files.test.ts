import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundleDocument,
  bundlePath,
  readBundleFolder,
  validateBundleFiles,
  writeBundleFiles,
} from "./files.js";

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp(path.join(tmpdir(), "extension-fixture-"));
  roots.push(root);
  return root;
}
const file = (name: string, value = "fixture") => ({
  path: name,
  bytes: new TextEncoder().encode(value),
});
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bundle filesystem boundary", () => {
  it.each([
    "../escape",
    "/escape",
    "C:/escape",
    "a/../b",
    "a\\b",
    "a//b",
    "a/",
    "nul.txt",
    "a/CON",
    "a/space ",
    "a\0b",
  ])("rejects %s", (name) => {
    expect(() => bundlePath(name)).toThrow();
  });
  it("rejects duplicate, case-colliding and file/directory-colliding entries before writing", async () => {
    const root = await temporary();
    for (const files of [
      [file("a"), file("a")],
      [file("a"), file("A")],
      [file("a"), file("a/b")],
    ]) {
      await expect(writeBundleFiles(path.join(root, "install"), files)).rejects.toThrow();
      await expect(readFile(path.join(root, "install", "a"))).rejects.toThrow();
    }
    expect(() => validateBundleFiles([])).toThrow();
  });
  it("writes a private tree, reads its documents, and refuses an existing destination", async () => {
    const root = await temporary();
    const destination = path.join(root, "installed");
    const files = [file("manifest.json", '{"name":"fixture"}'), file("server/index.js")];
    await writeBundleFiles(destination, files);
    expect(await readFile(path.join(destination, "server/index.js"), "utf8")).toBe("fixture");
    expect(bundleDocument(await readBundleFolder(destination), "manifest.json")).toBe(
      '{"name":"fixture"}',
    );
    await expect(writeBundleFiles(destination, [file("replace")])).rejects.toThrow();
    expect(await readFile(path.join(destination, "manifest.json"), "utf8")).toContain("fixture");
  });
  it("refuses symlink reads and excludes the Git object database", async () => {
    const root = await temporary();
    const source = path.join(root, "source");
    await mkdir(source);
    await writeFile(path.join(root, "outside"), "private fixture");
    await symlink(path.join(root, "outside"), path.join(source, "link"));
    await expect(readBundleFolder(source)).rejects.toThrow("symbolic links");
    await rm(path.join(source, "link"));
    await mkdir(path.join(source, ".git"));
    await writeFile(path.join(source, ".git", "config"), "excluded");
    await writeFile(path.join(source, "SKILL.md"), "recipe");
    expect((await readBundleFolder(source)).map((entry) => entry.path)).toEqual(["SKILL.md"]);
  });
  it("bounds and decodes documents without silent replacement characters", () => {
    expect(() =>
      bundleDocument([file("manifest.json", "x".repeat(128 * 1024 + 1))], "manifest.json"),
    ).toThrow();
    expect(() =>
      bundleDocument([{ path: "manifest.json", bytes: new Uint8Array([255]) }], "manifest.json"),
    ).toThrow();
  });
});
