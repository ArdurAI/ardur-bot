import { type ChildProcessByStdio, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { GitChangesResult, GitRunner, GitRunResult } from "@ardurbot/adapter-kit";
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
  };
  return {
    run(commandArgs, { cwd, maxBytes, timeoutMs }) {
      return new Promise<GitRunResult>((resolve) => {
        // stdio ["ignore", "pipe", "pipe"] guarantees both output streams.
        let child: ChildProcessByStdio<null, Readable, Readable>;
        try {
          child = spawn("git", [...commandArgs], {
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
const METADATA_ENTRIES = ["HEAD", "index", "packed-refs", "objects", "refs"] as const;

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
