import { type ChildProcessByStdio, spawn } from "node:child_process";
import { constants, createWriteStream, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  GitChangesResult,
  GitObservationRequest,
  GitRunner,
  GitRunResult,
} from "@ardurbot/adapter-kit";
import {
  GIT_OBSERVATION_BUDGET_MS,
  GIT_OBSERVATION_COMMAND_BYTES,
  observeGitChanges,
} from "@ardurbot/adapter-kit";
import { filterHostEnvironment } from "@ardurbot/contracts/host-environment";
import { redactCredentialText } from "../../logging/src/redaction.js";

/** stderr is kept only as a small classification tail; diff content never accumulates. */
const STDERR_TAIL_BYTES = 4096;
/** Exit code used when the deadline or the output cap stopped the command. */
export const GIT_COMMAND_ABORTED = 124;

/**
 * Runs Git with a fixed argument list, never through a shell. Global and system
 * configuration are made inaccessible, optional locks are off (no index writes),
 * stdout is capped and the process is killed at the deadline.
 */
export function createGitRunner(env: NodeJS.ProcessEnv = process.env): GitRunner {
  const baseEnv: NodeJS.ProcessEnv = {
    ...filterHostEnvironment(env),
    GIT_CONFIG_NOSYSTEM: "1",
    // A nonexistent/null global config file: repository config still applies but
    // nothing outside the bot's folder is read.
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    LC_ALL: "C",
  };
  return {
    run(commandArgs, { cwd, maxBytes, timeoutMs }) {
      return new Promise<GitRunResult>((resolve) => {
        // stdio ["ignore", "pipe", "pipe"] guarantees both output streams.
        let child: ChildProcessByStdio<null, Readable, Readable>;
        try {
          child = spawn("git", ["--no-pager", ...commandArgs], {
            cwd,
            shell: false,
            env: baseEnv,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          resolve({ stdout: new Uint8Array(), code: 128 });
          return;
        }
        const stdout: Buffer[] = [];
        const stderrTail: Buffer[] = [];
        let stderrBytes = 0;
        let total = 0;
        let settled = false;
        const finish = (result: GitRunResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const kill = (timedOut: boolean, capped: boolean) => {
          child.kill("SIGKILL");
          finish({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderrTail),
            code: GIT_COMMAND_ABORTED,
            ...(timedOut ? { timedOut } : {}),
            ...(capped ? { capped } : {}),
          });
        };
        const timer = setTimeout(() => kill(true, false), timeoutMs);
        timer.unref?.();
        child.stdout.on("data", (chunk: Buffer) => {
          if (settled) return;
          total += chunk.byteLength;
          if (total > maxBytes) {
            stdout.push(chunk.subarray(0, Math.max(0, maxBytes - (total - chunk.byteLength))));
            kill(false, true);
            return;
          }
          stdout.push(chunk);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (settled) return;
          const room = Math.max(0, STDERR_TAIL_BYTES - stderrBytes);
          stderrTail.push(chunk.subarray(0, room));
          stderrBytes += chunk.byteLength;
        });
        child.once("error", () => finish({ stdout: new Uint8Array(), code: 128 }));
        child.once("close", (code) => {
          finish({
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderrTail),
            code: typeof code === "number" ? code : 128,
          });
        });
      });
    },
  };
}

/** Metadata entries that must be plain directories or files, never links. */
const METADATA_ENTRIES = [
  "HEAD",
  "index",
  "packed-refs",
  "shallow",
  "config",
  "objects",
  "refs",
] as const;

/** Only these formatting settings can affect the observation; none launches a program. */
const OBSERVATION_CONFIG = new Set([
  "core.filemode",
  "core.ignorecase",
  "core.symlinks",
  "core.autocrlf",
  "core.eol",
]);

/** Windows has no O_NOFOLLOW; there the lstat guards are the only layer. */
const NOFOLLOW_OPEN = (constants.O_NOFOLLOW ?? 0) as number;
/** A plain open of a swapped-in FIFO waits for a writer; non-blocking never does. */
const NONBLOCK_OPEN = (constants.O_NONBLOCK ?? 0) as number;

/**
 * Copies one metadata file through a no-follow, non-blocking open, pinning it
 * to the identity the caller lstat'ed a moment earlier: a swap to a symlink
 * fails the open and a swap to a FIFO or any other file fails the
 * regular-file/dev/ino check, so a racer can neither redirect the copy at a
 * file outside the bot folder nor stall the observation on a writer.
 */
export async function copyPinnedFile(
  source: string,
  destination: string,
  expected: Pick<Stats, "dev" | "ino">,
): Promise<void> {
  const handle = await open(source, constants.O_RDONLY | NOFOLLOW_OPEN | NONBLOCK_OPEN);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error("Git metadata changed while it was being copied");
    }
    await pipeline(handle.createReadStream(), createWriteStream(destination));
  } finally {
    await handle.close();
  }
}

/**
 * Git's -c overrides cannot erase include directives or every possible driver.
 * Use a private metadata view with its own config instead. Original config is
 * parsed explicitly with includes disabled, outside repository discovery. Only
 * data/refs/index and local ignore/attribute data are shared; config and hooks
 * are never shared, so attribute-assigned drivers have no executable definition.
 */
export async function observeHostGitChanges(
  root: string,
  request: Pick<GitObservationRequest, "path" | "readWorktreeFile">,
): Promise<GitChangesResult> {
  // One deadline covers the whole observation, including the config read below.
  const deadlineMs = Date.now() + GIT_OBSERVATION_BUDGET_MS;
  const remaining = () => Math.max(1, deadlineMs - Date.now());
  const gitDir = path.join(root, ".git");
  const present = await lstat(gitDir).catch(() => null);
  if (!present) {
    // Distinguish a plain folder from an ancestor repository without asking Git
    // to discover (and load configuration from) a repository outside this root.
    for (let parent = path.dirname(root); ; parent = path.dirname(parent)) {
      if (await lstat(path.join(parent, ".git")).catch(() => null)) return { kind: "unavailable" };
      if (parent === path.dirname(parent)) break;
    }
    return { kind: "not-repository" };
  }
  let view: string | undefined;
  try {
    await assertSafeGitMetadata(root, gitDir);
    view = await mkdtemp(path.join(os.tmpdir(), "git-observation-"));
    const raw = createGitRunner();
    // --file and --no-includes prevent local/global/includes from participating.
    const config = await raw.run(
      ["config", "--null", "--list", "--no-includes", "--file", path.join(gitDir, "config")],
      { cwd: view, maxBytes: GIT_OBSERVATION_COMMAND_BYTES, timeoutMs: remaining() },
    );
    if (config.code !== 0 || config.capped || config.timedOut) return { kind: "unavailable" };
    const settings: string[] = [];
    for (const record of new TextDecoder().decode(config.stdout).split("\0")) {
      if (!record) continue;
      const separator = record.indexOf("\n");
      const key = separator < 0 ? record : record.slice(0, separator);
      const value = separator < 0 ? "true" : record.slice(separator + 1);
      // Includes can hide an outside worktree. Refuse them without opening them.
      if (key.startsWith("include.") || key.startsWith("includeif."))
        return { kind: "unavailable" };
      if (key === "core.worktree") {
        const configured = path.resolve(gitDir, value);
        if (path.resolve(await realpath(configured)) !== path.resolve(root))
          return { kind: "unavailable" };
      }
      // The shared observer currently supports ordinary SHA-1 file-based repos.
      if (
        key.startsWith("extensions.") ||
        (key === "core.repositoryformatversion" && value !== "0")
      )
        return { kind: "unavailable" };
      if (OBSERVATION_CONFIG.has(key)) settings.push("-c", `${key}=${value}`);
    }
    await writeFile(
      path.join(view, "config"),
      `[core]\nrepositoryformatversion = 0\nbare = false\nfsmonitor = false\nattributesfile = ${JSON.stringify(os.devNull)}\nexcludesfile = ${JSON.stringify(os.devNull)}\nhooksPath = ${JSON.stringify(os.devNull)}\npager = false\n`,
    );
    for (const entry of ["HEAD", "index", "packed-refs", "shallow", "objects", "refs"] as const) {
      const source = path.join(gitDir, entry);
      const info = await lstat(source).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink()) return { kind: "unavailable" };
      const destination = path.join(view, entry);
      if (info.isDirectory()) {
        await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
      } else if (info.isFile()) {
        // Private copies keep the observation from changing index bytes or inode
        // metadata; the no-follow open and identity check pin each file to what
        // the lstat above saw, so a swap in between cannot redirect the copy.
        await copyPinnedFile(source, destination, info);
      } else return { kind: "unavailable" };
    }
    const infoDirectory = path.join(gitDir, "info");
    const info = await lstat(infoDirectory).catch(() => null);
    if (info) {
      if (info.isSymbolicLink() || !info.isDirectory()) return { kind: "unavailable" };
      await mkdir(path.join(view, "info"));
      for (const entry of ["exclude", "attributes"] as const) {
        const source = path.join(infoDirectory, entry);
        const file = await lstat(source).catch(() => null);
        if (!file) continue;
        if (!file.isFile() || file.isSymbolicLink() || file.size > GIT_OBSERVATION_COMMAND_BYTES)
          return { kind: "unavailable" };
        await copyPinnedFile(source, path.join(view, "info", entry), file);
      }
    }
    const pinned = ["--no-pager", "--git-dir", view, "--work-tree", root, ...settings];
    const runner: GitRunner = {
      run: (args, options) => raw.run([...pinned, ...args], { ...options, cwd: root }),
    };
    return await observeGitChanges(runner, {
      ...request,
      root,
      gitDir,
      deadlineMs,
      assertSafeMetadata: (directory) => assertSafeGitMetadata(root, directory),
    });
  } catch {
    return { kind: "unavailable" };
  } finally {
    if (view) await rm(view, { recursive: true, force: true });
  }
}

/** Applies the existing credential redaction to every text that leaves the reader. */
export function redactGitChanges(result: GitChangesResult): GitChangesResult {
  if (result.kind === "diff") {
    return {
      ...result,
      before: result.before === null ? null : redactCredentialText(result.before),
      after: result.after === null ? null : redactCredentialText(result.after),
    };
  }
  if (result.kind === "status") {
    return {
      ...result,
      entries: result.entries.map((entry) => ({
        ...entry,
        path: redactCredentialText(entry.path),
      })),
    };
  }
  return result;
}

/**
 * Refuses repository layouts that could read or expose anything outside the bot
 * folder: a `.git` link or special file, a common directory, object alternates,
 * or symlinked metadata (a swapped index could leak an outside file through diff).
 */
export async function assertSafeGitMetadata(root: string, gitDir: string): Promise<void> {
  const expected = path.join(root, ".git");
  if (path.resolve(gitDir) !== path.resolve(expected))
    throw new Error("Git metadata escapes the bot folder");
  const dotGit = await lstat(expected).catch(() => null);
  if (!dotGit || dotGit.isSymbolicLink() || !dotGit.isDirectory()) {
    throw new Error("Unsafe .git metadata");
  }
  for (const entry of METADATA_ENTRIES) {
    const info = await lstat(path.join(expected, entry)).catch(() => null);
    if (!info) continue;
    if (info.isSymbolicLink()) throw new Error("Symlinked Git metadata");
    if (!info.isDirectory() && !info.isFile()) throw new Error("Special Git metadata file");
  }
  // Linked worktrees and submodule gitfiles share metadata elsewhere; refuse both.
  const commonDir = await readFile(path.join(expected, "commondir"), "utf8").catch(() => null);
  if (commonDir !== null) throw new Error("Common Git directory refused");
  const alternates = await readFile(
    path.join(expected, "objects", "info", "alternates"),
    "utf8",
  ).catch(() => null);
  if (alternates !== null && alternates.trim() !== "")
    throw new Error("Git object alternates refused");
}
