import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_FLEET_ARCHIVE, readFleetArchive } from "./archive.js";
import { LINUX_ARCHIVE_SCRIPT } from "./linux-scripts.js";

const python = spawnSync("python3", ["--version"]).status === 0;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace() {
  // The script refuses symlinked path parts; resolve the temporary folder first.
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fleet-archive-")));
  roots.push(root);
  return root;
}
function batch(root: string, exported?: number) {
  const args = ["-c", LINUX_ARCHIVE_SCRIPT, root];
  if (exported !== undefined) args.push(String(exported));
  return execFileSync("python3", args, { maxBuffer: MAX_FLEET_ARCHIVE + 1024 });
}
function exportAll(root: string) {
  const batches: string[][] = [];
  for (let exported = 0; ; ) {
    const archive = batch(root, exported);
    expect(archive.length).toBeLessThanOrEqual(MAX_FLEET_ARCHIVE);
    const paths = [...readFleetArchive(archive)].map((file) => file.path);
    if (paths.length === 0) return batches;
    batches.push(paths);
    exported += paths.length;
  }
}

// 2026-10-01: moving a Team computer off Docker failed at "Saving your workspace" because a
// 433 MB workspace could not be exported in one 64 MiB archive.
describe.skipIf(!python)("exporting a workspace larger than one archive", () => {
  it("exports by size in several batches, each within the archive limit, every file once", () => {
    const root = workspace();
    mkdirSync(path.join(root, "tasks/a"), { recursive: true });
    const expected: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      writeFileSync(path.join(root, `tasks/a/big-${i}.bin`), Buffer.alloc(15 * 1024 * 1024, i));
      expected.push(`tasks/a/big-${i}.bin`);
    }
    writeFileSync(path.join(root, "notes.md"), "kept");
    expected.push("notes.md");
    const batches = exportAll(root);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flat().sort()).toEqual(expected.sort());
  });

  it("exports by file count in several batches", () => {
    const root = workspace();
    mkdirSync(path.join(root, "many"));
    for (let i = 0; i < 9_100; i += 1) writeFileSync(path.join(root, `many/f${i}.txt`), "");
    const batches = exportAll(root);
    expect(batches.map((paths) => paths.length)).toEqual([9_000, 100]);
    expect(new Set(batches.flat()).size).toBe(9_100);
  });

  it("returns an empty archive for an empty workspace and keeps the one-call form", () => {
    const root = workspace();
    expect(exportAll(root)).toEqual([]);
    writeFileSync(path.join(root, "only.txt"), "x");
    expect([...readFleetArchive(batch(root))].map((file) => file.path)).toEqual(["only.txt"]);
  });
});
