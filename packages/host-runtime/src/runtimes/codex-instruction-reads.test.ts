import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { instructionFileReads } from "./codex-app-server-runtime.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

it("grants the instruction files from the git root down to the folder", async () => {
  root = await mkdtemp(path.join(tmpdir(), "codex-reads-"));
  const repo = path.join(root, "repo");
  const folder = path.join(repo, "a", "b");
  await mkdir(path.join(repo, ".git"), { recursive: true });
  await mkdir(folder, { recursive: true });
  const reads = await instructionFileReads(folder);
  expect(Object.keys(reads).sort()).toEqual(
    [repo, path.join(repo, "a"), folder]
      .flatMap((dir) => [path.join(dir, "AGENTS.md"), path.join(dir, "AGENTS.override.md")])
      .sort(),
  );
  expect(new Set(Object.values(reads))).toEqual(new Set(["read"]));
  expect(reads[path.join(root, "AGENTS.md")]).toBeUndefined();
});

it("grants only the folder's own instruction files when there is no git root", async () => {
  root = await mkdtemp(path.join(tmpdir(), "codex-reads-"));
  const folder = path.join(root, "home");
  await mkdir(folder, { recursive: true });
  const reads = await instructionFileReads(folder);
  expect(Object.keys(reads).sort()).toEqual(
    [path.join(folder, "AGENTS.md"), path.join(folder, "AGENTS.override.md")].sort(),
  );
});
