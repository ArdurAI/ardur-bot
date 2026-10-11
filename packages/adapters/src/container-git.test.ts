import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  GIT_OBSERVATION_COMMAND_BYTES,
  GIT_OBSERVATION_TEXT_SIDE_BYTES,
  type GitRunResult,
} from "@ardurbot/adapter-kit";
import { COMMAND_TRUNCATED } from "@ardurbot/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTAINER_GIT_ENV,
  type ContainerCommandRequest,
  type ContainerCommandRunner,
  decodeContainerExecOutput,
  observeContainerGitChanges,
  readBoundedWorktreeFile,
} from "./container-git.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function ok(stdout: string, extra: Partial<GitRunResult> = {}): GitRunResult {
  return { stdout: new TextEncoder().encode(stdout), code: 0, ...extra };
}

function fakeRunner() {
  const calls: ContainerCommandRequest[] = [];
  const queue: GitRunResult[] = [];
  const runner: ContainerCommandRunner = {
    async run(request) {
      calls.push(request);
      const next = queue.shift();
      if (!next) throw new Error(`unexpected git invocation: ${request.argv.join(" ")}`);
      return next;
    },
  };
  return { calls, queue, runner };
}

function repository(fake: ReturnType<typeof fakeRunner>, root: string, results: GitRunResult[]) {
  fake.queue.push(ok(`${root}/.git\n`));
  fake.queue.push(ok(`${"a".repeat(40)}\n`));
  fake.queue.push(...results);
}

function assertReadOnlyGitCall(call: ContainerCommandRequest) {
  expect(call.argv[0]).toBe("git");
  expect(call.argv).toContain("--no-pager");
  expect(call.argv).toContain("--no-optional-locks");
  expect(call.argv).toContain("core.hooksPath=");
  expect(call.argv).toContain("core.fsmonitor=false");
  expect(call.argv).toContain("diff.external=");
  expect(call.env).toMatchObject(CONTAINER_GIT_ENV);
  expect(call.env.GIT_OPTIONAL_LOCKS).toBe("0");
  // A shell string would be one element. Every flag is its own argument.
  expect(call.argv.some((part) => /[;&|`$()]/.test(part))).toBe(false);
  expect(call.argv.join(" ").includes("sh -c")).toBe(false);
}

describe("container git command flags", () => {
  it("puts the read-only flags and environment on every git call", async () => {
    const root = "/home/ardurbot";
    const fake = fakeRunner();
    repository(fake, root, [
      ok(" M app.ts\0"),
      ok("--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-old\n+new\n"),
    ]);
    const result = await observeContainerGitChanges(fake.runner, { root, path: "app.ts" });
    expect(result.kind).toBe("diff");
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      assertReadOnlyGitCall(call);
      expect(call.cwd).toBe(root);
      expect(call.maxBytes).toBeGreaterThan(0);
      expect(call.maxBytes).toBeLessThanOrEqual(GIT_OBSERVATION_COMMAND_BYTES);
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(5_000);
    }
    const diff = fake.calls.at(-1)!;
    expect(diff.argv).toContain("--no-ext-diff");
    expect(diff.argv).toContain("--no-textconv");
    expect(diff.maxBytes).toBe(GIT_OBSERVATION_COMMAND_BYTES);
  });

  it("forwards a capped command as a truncated observation", async () => {
    const root = "/home/ardurbot";
    const fake = fakeRunner();
    repository(fake, root, [ok(" M app.ts\0", { capped: true })]);
    const result = await observeContainerGitChanges(fake.runner, { root });
    expect(result).toMatchObject({ kind: "status", truncated: true });
  });

  it("stops when the shared deadline is already spent", async () => {
    const fake = fakeRunner();
    const result = await observeContainerGitChanges(fake.runner, {
      root: "/home/ardurbot",
      deadlineMs: Date.now() - 1,
    });
    expect(result).toEqual({ kind: "unavailable" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("decodeContainerExecOutput", () => {
  it("keeps null bytes and strips the truncation marker", () => {
    const decoded = decodeContainerExecOutput({
      stdout: `a\0b\n${COMMAND_TRUNCATED}`,
      stderr: "note",
      code: 0,
    });
    expect(Array.from(decoded.stdout)).toEqual([97, 0, 98]);
    expect(decoded.capped).toBe(true);
    expect(new TextDecoder().decode(decoded.stderr)).toBe("note");
  });

  it("marks a deadline exit as timed out", () => {
    expect(decodeContainerExecOutput({ stdout: "", code: 124 }).timedOut).toBe(true);
  });
});

function hostRunner(): ContainerCommandRunner {
  return {
    run(request) {
      return new Promise((resolve) => {
        const child = spawn(request.argv[0]!, request.argv.slice(1), {
          cwd: request.cwd,
          shell: false,
          env: { PATH: process.env.PATH, ...request.env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let total = 0;
        let settled = false;
        const finish = (result: GitRunResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            code: 124,
            timedOut: true,
          });
        }, request.timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > request.maxBytes) {
            stdout.push(
              chunk.subarray(0, Math.max(0, request.maxBytes - (total - chunk.byteLength))),
            );
            child.kill("SIGKILL");
            finish({
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr),
              code: 124,
              capped: true,
            });
            return;
          }
          stdout.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr.push(chunk.subarray(0, 4096));
        });
        child.once("error", () => finish({ stdout: new Uint8Array(), code: 128 }));
        child.once("close", (code) => {
          finish({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            code: typeof code === "number" ? code : 128,
          });
        });
      });
    },
  };
}

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "container-git-")));
  roots.push(root);
  const git = (args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
  return { root, git, runner: hostRunner() };
}

async function indexSnapshot(root: string) {
  const index = path.join(root, ".git", "index");
  const info = await stat(index);
  return { bytes: await readFile(index), mtimeMs: info.mtimeMs, size: info.size };
}

describe("container git observation on a temporary repository", () => {
  it("shows staged, unstaged, untracked and renamed paths without writing the index", async () => {
    const { root, git, runner } = await fixture();
    git(["init", "-q", "-b", "main"]);
    await writeFile(path.join(root, "staged.md"), "one\n");
    git(["add", "staged.md"]);
    git(["commit", "-q", "-m", "base"]);
    await writeFile(path.join(root, "staged.md"), "two\n");
    git(["add", "staged.md"]);
    await writeFile(path.join(root, "unstaged.md"), "old\n");
    git(["add", "unstaged.md"]);
    git(["commit", "-q", "-m", "second"]);
    await writeFile(path.join(root, "unstaged.md"), "new\n");
    git(["mv", "staged.md", "renamed.md"]);
    await writeFile(path.join(root, "note name.md"), "spaced\n");
    const before = await indexSnapshot(root);

    const status = await observeContainerGitChanges(runner, { root });
    const staged = await observeContainerGitChanges(runner, { root, path: "renamed.md" });
    const unstaged = await observeContainerGitChanges(runner, { root, path: "unstaged.md" });
    const untracked = await observeContainerGitChanges(runner, { root, path: "note name.md" });
    const after = await indexSnapshot(root);

    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(status).toMatchObject({ kind: "status" });
    if (status.kind !== "status") throw new Error("unreachable");
    expect(status.entries).toEqual(
      expect.arrayContaining([
        { path: "staged.md", staged: true, unstaged: false, untracked: false, conflict: false },
        { path: "renamed.md", staged: true, unstaged: false, untracked: false, conflict: false },
        { path: "unstaged.md", staged: false, unstaged: true, untracked: false, conflict: false },
        { path: "note name.md", staged: false, unstaged: false, untracked: true, conflict: false },
      ]),
    );
    expect(staged).toMatchObject({ kind: "diff", binary: false });
    expect(unstaged).toMatchObject({ kind: "diff", before: "old", after: "new" });
    expect(untracked).toMatchObject({ kind: "diff", before: null, after: "spaced" });
  });

  it("reports binary and oversized files without returning the whole file", async () => {
    const { root, git, runner } = await fixture();
    git(["init", "-q", "-b", "main"]);
    await writeFile(path.join(root, "image.bin"), Buffer.from([1, 0, 2]));
    git(["add", "image.bin"]);
    git(["commit", "-q", "-m", "base"]);
    await writeFile(path.join(root, "image.bin"), Buffer.from([3, 0, 4]));
    await writeFile(path.join(root, "big.md"), "x".repeat(GIT_OBSERVATION_TEXT_SIDE_BYTES + 64));
    const before = await indexSnapshot(root);

    const binary = await observeContainerGitChanges(runner, { root, path: "image.bin" });
    const oversized = await observeContainerGitChanges(runner, { root, path: "big.md" });
    const after = await indexSnapshot(root);

    expect(after.bytes.equals(before.bytes)).toBe(true);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(binary).toMatchObject({ kind: "diff", binary: true, truncated: false });
    expect(oversized).toMatchObject({ kind: "diff", binary: false, truncated: true });
    if (oversized.kind !== "diff") throw new Error("unreachable");
    expect(oversized.after!.length).toBeLessThanOrEqual(GIT_OBSERVATION_TEXT_SIDE_BYTES);
  });

  it("refuses a path that escapes the workspace and a symlink to an outside file", async () => {
    const { root, git, runner } = await fixture();
    git(["init", "-q", "-b", "main"]);
    git(["commit", "-q", "--allow-empty", "-m", "base"]);
    const outside = path.join(path.dirname(root), `outside-secret-${path.basename(root)}.txt`);
    await writeFile(outside, "secret outside\n");
    try {
      await symlink(outside, path.join(root, "link.md"));
      const escaped = await observeContainerGitChanges(runner, {
        root,
        path: "../outside-secret.txt",
      });
      const linked = await observeContainerGitChanges(runner, { root, path: "link.md" });
      expect(escaped).toEqual({ kind: "unavailable" });
      expect(linked).toEqual({ kind: "unavailable" });
      expect(JSON.stringify(linked)).not.toContain("secret outside");
      await expect(readBoundedWorktreeFile(root, "link.md", { maxBytes: 32 })).rejects.toThrow(
        /non-regular/i,
      );
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("redacts credential text before it leaves the reader", async () => {
    const { root, git, runner } = await fixture();
    git(["init", "-q", "-b", "main"]);
    await writeFile(path.join(root, "env"), "plain\n");
    git(["add", "env"]);
    git(["commit", "-q", "-m", "base"]);
    await writeFile(path.join(root, "env"), "TOKEN=fixture-secret-value\n");
    const diff = await observeContainerGitChanges(runner, { root, path: "env" });
    expect(diff).toMatchObject({ kind: "diff" });
    if (diff.kind !== "diff") throw new Error("unreachable");
    expect(diff.after).not.toContain("fixture-secret-value");
    expect(diff.after).toContain("[Redacted]");
  });

  it("does not run a repository fsmonitor or external diff", async () => {
    const { root, git, runner } = await fixture();
    git(["init", "-q", "-b", "main"]);
    await writeFile(path.join(root, "tracked.txt"), "before\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-q", "-m", "base"]);
    await writeFile(path.join(root, "tracked.txt"), "after\n");
    const marker = path.join(root, "helper-ran");
    await writeFile(path.join(root, "probe.sh"), "#!/bin/sh\ntouch helper-ran\n");
    await chmod(path.join(root, "probe.sh"), 0o755);
    git(["config", "core.fsmonitor", "./probe.sh"]);
    git(["config", "diff.external", "./probe.sh"]);
    const status = await observeContainerGitChanges(runner, { root });
    const diff = await observeContainerGitChanges(runner, { root, path: "tracked.txt" });
    expect(status.kind).toBe("status");
    expect(diff).toMatchObject({ kind: "diff", before: "before", after: "after" });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("readBoundedWorktreeFile", () => {
  it("refuses a fifo", async () => {
    if (process.platform === "win32") return;
    const { root, git } = await fixture();
    git(["init", "-q", "-b", "main"]);
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    await expect(readBoundedWorktreeFile(root, "pipe", { maxBytes: 8 })).rejects.toThrow(
      /non-regular/i,
    );
  });
});
