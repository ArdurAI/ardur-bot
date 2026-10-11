/**
 * Read-only Git observation for a computer whose files live in a container.
 *
 * The caller runs each command through the provider's existing exec path. This
 * module runs a fixed isolation script and hands results to observeGitChanges,
 * which owns the deadline, output caps, status and diff parsing. Nothing here
 * joins a shell string or writes the worktree or original metadata.
 */
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  GitChangesResult,
  GitObservationRequest,
  GitRunner,
  GitRunResult,
} from "@ardurbot/adapter-kit";
import { GIT_OBSERVATION_TEXT_SIDE_BYTES, observeGitChanges } from "@ardurbot/adapter-kit";
import { COMMAND_TRUNCATED } from "@ardurbot/contracts";
import { redactGitChanges } from "@ardurbot/host-runtime/git-reader";
import { CONTAINER_GIT_SCRIPT } from "./container-git-script.js";

/**
 * Process environment for those invocations. Global and system configuration
 * stay unread so they cannot enable a pager, a filter or an external diff.
 */
export const CONTAINER_GIT_ENV: Record<string, string> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  LC_ALL: "C",
};

export interface ContainerCommandRequest {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
}

/** Runs one fixed argument list inside the computer. Never a shell string. */
export interface ContainerCommandRunner {
  run(request: ContainerCommandRequest): Promise<GitRunResult>;
}

/** Turns one observation command into the exec request the container runner sends. */
export function containerGitCommand(
  args: readonly string[],
  options: { cwd: string; maxBytes: number; timeoutMs: number },
): ContainerCommandRequest {
  return {
    argv: ["python3", "-I", "-c", CONTAINER_GIT_SCRIPT, options.cwd, ...args],
    cwd: options.cwd,
    env: { ...CONTAINER_GIT_ENV },
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
  };
}

export function createContainerGitRunner(commands: ContainerCommandRunner): GitRunner {
  return {
    run(args, options) {
      return commands.run(containerGitCommand(args, options));
    },
  };
}

const TRUNCATION_MARKER = `\n${COMMAND_TRUNCATED}`;

/**
 * The exec path returns text and may append a truncation marker. Strip that
 * marker so porcelain and diffs are not parsed as file content, and keep the
 * cap flag so the observation can say the listing was cut.
 */
export function decodeContainerExecOutput(body: {
  stdout?: string;
  stderr?: string;
  code: number;
  capped?: boolean;
}): GitRunResult {
  let stdout = body.stdout ?? "";
  let capped = body.capped === true;
  if (stdout.endsWith(TRUNCATION_MARKER)) {
    stdout = stdout.slice(0, -TRUNCATION_MARKER.length);
    capped = true;
  } else if (stdout === COMMAND_TRUNCATED) {
    stdout = "";
    capped = true;
  }
  const stderr = body.stderr ?? "";
  return {
    stdout: new TextEncoder().encode(stdout),
    ...(stderr ? { stderr: new TextEncoder().encode(stderr) } : {}),
    code: body.code,
    ...(body.code === 124 ? { timedOut: true } : {}),
    ...(capped ? { capped: true } : {}),
  };
}

/**
 * Reads one worktree file without following a link out of `root`. Used when the
 * observation runs against a host checkout; a container read uses the provider's
 * contained file API, which applies the same regular-file and path rules.
 */
export async function readBoundedWorktreeFile(
  root: string,
  relative: string,
  options: { maxBytes: number; signal?: AbortSignal },
): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  if (
    !relative ||
    relative.includes("\0") ||
    relative.startsWith("/") ||
    path.win32.isAbsolute(relative) ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Path escapes the workspace");
  }
  const rootReal = await realpath(root);
  const target = path.resolve(rootReal, relative);
  const parent = path.dirname(target);
  const parentReal = await realpath(parent);
  const inside =
    parentReal === rootReal ||
    parentReal.startsWith(`${rootReal}${path.sep}`) ||
    parentReal.startsWith(`${rootReal}/`);
  if (!inside) throw new Error("Path escapes the workspace");
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Refusing a non-regular file");
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) {
      throw new Error("Refusing a non-regular file");
    }
    const buffer = Buffer.alloc(options.maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return new Uint8Array(buffer.subarray(0, Math.min(offset, options.maxBytes)));
  } finally {
    await handle.close();
  }
}

export async function observeContainerGitChanges(
  commands: ContainerCommandRunner,
  request: {
    root: string;
    path?: string;
    deadlineMs?: number;
    readWorktreeFile?: GitObservationRequest["readWorktreeFile"];
  },
): Promise<GitChangesResult> {
  const readWorktreeFile =
    request.readWorktreeFile ??
    ((relative: string, options?: { signal?: AbortSignal }) =>
      readBoundedWorktreeFile(request.root, relative, {
        maxBytes: GIT_OBSERVATION_TEXT_SIDE_BYTES + 1,
        signal: options?.signal,
      }));
  const result = await observeGitChanges(createContainerGitRunner(commands), {
    root: request.root,
    path: request.path,
    deadlineMs: request.deadlineMs,
    readWorktreeFile,
  });
  return redactGitChanges(result);
}
