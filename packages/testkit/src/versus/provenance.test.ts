import childProcess from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { RESEARCH_BASELINE } from "./manifest.js";
import { inspectBuild } from "./provenance.js";

it("binds tracked, staged, new and deleted product source plus the lock, without unrelated docs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "versus-source-test-"));
  const execute = childProcess.execFileSync;
  const git = (...args: string[]) =>
    execute(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture.invalid",
        ...args,
      ],
      { cwd: root, stdio: "pipe", encoding: "utf8" },
    );
  try {
    await mkdir(path.join(root, "packages/testkit/src/versus"), { recursive: true });
    await mkdir(path.join(root, "packages/adapters/src"), { recursive: true });
    await writeFile(
      path.join(root, "packages/testkit/src/versus/fixture.ts"),
      "export const synthetic = true;\n",
    );
    const product = path.join(root, "packages/adapters/src/runtime.ts");
    await writeFile(product, "export const revision = 1;\n");
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git("init");
    git("add", ".");
    git("commit", "-m", "Synthetic baseline");
    git("commit", "--allow-empty", "-m", "Synthetic head");
    // The research baseline belongs to the real repository, not this disposable fixture.
    vi.spyOn(childProcess, "execFileSync").mockImplementation(((
      file: string,
      args: string[],
      options: unknown,
    ) => {
      if (file === "git" && args.includes(`${RESEARCH_BASELINE}^{commit}`))
        return RESEARCH_BASELINE;
      return execute(file, args, options as never);
    }) as typeof childProcess.execFileSync);
    syncBuiltinESMExports();
    const clean = await inspectBuild(root);
    expect(clean.build.dirty).toBe(false);
    await writeFile(product, "export const revision = 2;\n");
    const changed = await inspectBuild(root);
    expect(changed.build.dirty).toBe(true);
    expect(changed.build.diffDigest).not.toBeNull();
    expect(changed.build.artifactHash).not.toBe(clean.build.artifactHash);
    git("add", "packages/adapters/src/runtime.ts");
    expect((await inspectBuild(root)).build.dirty).toBe(true);
    git("commit", "-m", "Synthetic runtime change");
    await writeFile(
      path.join(root, "packages/adapters/src/new.ts"),
      "export const additional = true;\n",
    );
    const added = await inspectBuild(root);
    expect(added.build.dirty).toBe(true);
    expect(
      added.buildArtifact.inventory.some((entry) => entry.file.endsWith("/new.ts") && entry.sha256),
    ).toBe(true);
    await rm(path.join(root, "packages/adapters/src/new.ts"));
    await rm(product);
    const removed = await inspectBuild(root);
    expect(removed.build.dirty).toBe(true);
    expect(
      removed.buildArtifact.inventory.find((entry) => entry.file.endsWith("/runtime.ts"))?.sha256,
    ).toBeNull();
    git("restore", "packages/adapters/src/runtime.ts");
    const baseline = await inspectBuild(root);
    await writeFile(path.join(root, "unrelated.md"), "Synthetic unrelated note\n");
    expect((await inspectBuild(root)).build).toEqual(baseline.build);
    const lock = path.join(root, "pnpm-lock.yaml");
    await writeFile(lock, `${await readFile(lock, "utf8")}settings: {}\n`);
    const dependencies = await inspectBuild(root);
    expect(dependencies.build.dirty).toBe(true);
    expect(dependencies.dependencyLock).not.toBe(baseline.dependencyLock);
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

it("treats a staged deletion of harness source as a dirty build", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "versus-staged-delete-"));
  const execute = childProcess.execFileSync;
  const git = (...args: string[]) =>
    execute(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture.invalid",
        ...args,
      ],
      { cwd: root, stdio: "pipe", encoding: "utf8" },
    );
  try {
    await mkdir(path.join(root, "packages/testkit/src/versus"), { recursive: true });
    await writeFile(
      path.join(root, "packages/testkit/src/versus/fixture.ts"),
      "export const synthetic = true;\n",
    );
    // A sibling keeps the source directory after the staged deletion.
    await writeFile(
      path.join(root, "packages/testkit/src/versus/kept.ts"),
      "export const kept = true;\n",
    );
    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    git("init");
    git("add", ".");
    git("commit", "-m", "Synthetic baseline");
    git("commit", "--allow-empty", "-m", "Synthetic head");
    vi.spyOn(childProcess, "execFileSync").mockImplementation(((
      file: string,
      args: string[],
      options: unknown,
    ) => {
      if (file === "git" && args.includes(`${RESEARCH_BASELINE}^{commit}`))
        return RESEARCH_BASELINE;
      return execute(file, args, options as never);
    }) as typeof childProcess.execFileSync);
    syncBuiltinESMExports();
    expect((await inspectBuild(root)).build.dirty).toBe(false);
    git("rm", "packages/testkit/src/versus/fixture.ts");
    const staged = await inspectBuild(root);
    expect(staged.build.dirty).toBe(true);
    expect(staged.build.diffDigest).not.toBeNull();
    expect(
      staged.buildArtifact.inventory.find((entry) => entry.file.endsWith("/versus/fixture.ts"))
        ?.sha256,
    ).toBeNull();
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});
