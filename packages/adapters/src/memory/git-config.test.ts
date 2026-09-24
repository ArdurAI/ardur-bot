import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { memoryGitMachine } from "./git-config.js";

describe("Git memory machine identity", () => {
  it("is stable across concurrent API/worker initialization and distinct across storage directories", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "git-machine-fixture-")));
    try {
      const machines = await Promise.all(Array.from({ length: 8 }, () => memoryGitMachine(root)));
      expect(new Set(machines).size).toBe(1);
      expect(await memoryGitMachine(root)).toBe(machines[0]);
      const other = await memoryGitMachine(path.join(root, "other"));
      expect(other).not.toBe(machines[0]);
      expect(await readdir(path.join(root, "memory-git"))).toEqual(["machine-id"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("rejects a symbolic-link machine identity", async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "git-machine-fixture-")));
    try {
      await mkdir(path.join(root, "memory-git"));
      await symlink(path.join(root, "outside"), path.join(root, "memory-git/machine-id"));
      await expect(memoryGitMachine(root)).rejects.toThrow("symbolic links");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
