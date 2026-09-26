import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { directorySize } from "./size-walk.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "size-walk-"));
  directories.push(dir);
  return dir;
}

describe("directorySize", () => {
  it("sums file bytes recursively", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "a.txt"), "12345");
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "b.txt"), "1234567");
    const size = await directorySize([root]);
    expect(size).toEqual({ bytes: 12, approximate: false });
  });

  it("returns zero for a directory that does not exist", async () => {
    const size = await directorySize([path.join(tmpdir(), "size-walk-missing-forever")]);
    expect(size).toEqual({ bytes: 0, approximate: false });
  });

  it("sums bytes across multiple roots under one shared cap", async () => {
    const rootA = await tempDir();
    const rootB = await tempDir();
    await writeFile(path.join(rootA, "a.txt"), "1234567890");
    await writeFile(path.join(rootB, "b.txt"), "12345");
    const size = await directorySize([rootA, rootB]);
    expect(size).toEqual({ bytes: 15, approximate: false });
  });

  it("does not follow a symlinked directory, even one that points back at its parent", async () => {
    const root = await tempDir();
    await writeFile(path.join(root, "real.txt"), "12345");
    // A cycle: if the walk followed this, it would never terminate.
    await symlink(root, path.join(root, "loop"), "dir");
    const outside = await tempDir();
    await writeFile(path.join(outside, "secret.txt"), "1".repeat(1000));
    await symlink(outside, path.join(root, "elsewhere"), "dir");
    const size = await directorySize([root]);
    expect(size).toEqual({ bytes: 5, approximate: false });
  });

  it("does not follow a symlinked file", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(path.join(outside, "big.bin"), "1".repeat(1000));
    await symlink(path.join(outside, "big.bin"), path.join(root, "link.bin"), "file");
    const size = await directorySize([root]);
    expect(size).toEqual({ bytes: 0, approximate: false });
  });

  it("stops at the entry cap and reports the total as approximate", async () => {
    const root = await tempDir();
    for (let i = 0; i < 10; i += 1) {
      await writeFile(path.join(root, `file-${i}.txt`), "12345");
    }
    const size = await directorySize([root], 4);
    expect(size.approximate).toBe(true);
    // Only entries counted before the cap tripped are summed; never more than the cap allows.
    expect(size.bytes).toBeLessThanOrEqual(4 * 5);
    expect(size.bytes).toBeGreaterThan(0);
  });

  it("stays under the cap when the tree is exactly at the limit", async () => {
    const root = await tempDir();
    for (let i = 0; i < 4; i += 1) {
      await writeFile(path.join(root, `file-${i}.txt`), "1");
    }
    const size = await directorySize([root], 4);
    expect(size).toEqual({ bytes: 4, approximate: false });
  });
});
