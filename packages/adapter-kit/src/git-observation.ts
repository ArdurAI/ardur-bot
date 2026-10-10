/**
 * Read-only Git worktree observation.
 *
 * The runner executes Git with a fixed argument list, never through a shell, and
 * every invocation is bounded by an output size and a hard deadline. Only status,
 * revision resolution and diff plumbing are used; no write, fetch, checkout or
 * reset command ever appears here, and repository configuration that could
 * execute (fsmonitor, external diff, textconv filters) is disabled per call.
 */

/** Maximum status entries returned for one observation. */
export const GIT_OBSERVATION_MAX_ENTRIES = 1000;
/** Maximum text bytes kept per diff side. */
export const GIT_OBSERVATION_TEXT_SIDE_BYTES = 128 * 1024;
/** Maximum total returned diff content. */
export const GIT_OBSERVATION_RETURNED_BYTES = 512 * 1024;
/** Maximum bytes accepted from a single Git command's stdout. */
export const GIT_OBSERVATION_COMMAND_BYTES = 1024 * 1024;
/** Hard deadline for a single Git command. */
export const GIT_OBSERVATION_TIMEOUT_MS = 5000;

export interface GitRunResult {
  stdout: Uint8Array;
  /** Small stderr tail for classifying failures; never the full stream. */
  stderr?: Uint8Array;
  /** Process exit code; 124 when the deadline killed it or the output cap stopped it. */
  code: number;
  /** True when the deadline killed the command. */
  timedOut?: boolean;
  /** True when stdout reached the output cap and the command was stopped. */
  capped?: boolean;
}

/**
 * Executes Git with a fixed argument list. Implementations must spawn the binary
 * directly (never a shell), honor `maxBytes` and `timeoutMs`, and never mutate
 * the working tree or index.
 */
export interface GitRunner {
  run(
    args: readonly string[],
    options: { cwd: string; maxBytes: number; timeoutMs: number },
  ): Promise<GitRunResult>;
}

export interface GitStatusEntry {
  /** Repository-relative path. */
  path: string;
  /** HEAD-to-index side differs. */
  staged: boolean;
  /** Index-to-worktree side differs. */
  unstaged: boolean;
  /** Absent from the index. */
  untracked: boolean;
  /** The path carries a merge-conflict state. */
  conflict: boolean;
}

export type GitChangesResult =
  | { kind: "status"; head: string | null; entries: GitStatusEntry[]; truncated: boolean }
  | {
      kind: "diff";
      before: string | null;
      after: string | null;
      binary: boolean;
      truncated: boolean;
    }
  /** The folder is not inside a Git worktree. */
  | { kind: "not-repository" }
  /** Refused or failed: external gitdir, unsafe metadata, timeout, missing binary, … */
  | { kind: "unavailable" };

export interface GitObservationRequest {
  /** Canonical bot workspace root; the repository must live directly inside it. */
  root: string;
  /** Repository-relative file to diff; omit for the status listing. */
  path?: string;
  /** Read a worktree file for an untracked diff; the caller bounds the read. */
  readWorktreeFile?: (path: string) => Promise<Uint8Array>;
  /**
   * Verify the on-disk `.git` metadata for the repository Git reported
   * (contained gitdir, no common directory, no alternates, no metadata symlinks).
   */
  assertSafeMetadata?: (gitDir: string) => Promise<void>;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Disables repository-config hooks that could execute during read-only commands. */
const SAFE_CONFIG = ["-c", "core.fsmonitor=false"] as const;

const decoder = new TextDecoder("utf-8", { fatal: false });

function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function isWorktreeMetadataPath(path: string): boolean {
  const first = path.split("/")[0];
  return first === ".git" || first === ".GIT";
}

function repositoryRelativePath(path: string): string | null {
  if (
    !path ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    isWorktreeMetadataPath(path)
  )
    return null;
  return path;
}

async function runGit(
  runner: GitRunner,
  root: string,
  args: readonly string[],
  maxBytes = GIT_OBSERVATION_COMMAND_BYTES,
): Promise<GitRunResult> {
  return runner.run(args, { cwd: root, maxBytes, timeoutMs: GIT_OBSERVATION_TIMEOUT_MS });
}

/** Locate the repository; only a `.git` directory directly inside the root is accepted. */
async function resolveGitDir(
  runner: GitRunner,
  root: string,
): Promise<string | null | "unavailable"> {
  const probe = await runGit(runner, root, ["rev-parse", "--absolute-git-dir"], 4096);
  if (probe.timedOut) return "unavailable";
  if (probe.code !== 0) {
    const stderr = decode(probe.stderr ?? new Uint8Array());
    if (probe.code === 128 && /not a git repository/iu.test(stderr)) return null;
    return "unavailable";
  }
  const gitDir = decode(probe.stdout).trim();
  if (!gitDir || pathResolve(gitDir) !== pathResolve(joinPath(root, ".git"))) return "unavailable";
  return gitDir;
}

function pathResolve(candidate: string): string {
  // Minimal POSIX-style normalization so this module stays free of host path APIs.
  const parts = candidate.split("/").filter((part) => part !== "" && part !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return `/${resolved.join("/")}`;
}

function joinPath(root: string, child: string): string {
  return `${root.replace(/\/+$/u, "")}/${child}`;
}

async function resolveHead(
  runner: GitRunner,
  root: string,
): Promise<string | null | "unavailable"> {
  const head = await runGit(runner, root, ["rev-parse", "--verify", "HEAD"], 4096);
  if (head.timedOut) return "unavailable";
  if (head.code !== 0) {
    // An unborn branch (no commits yet) is a valid repository state.
    const stderr = decode(head.stderr ?? new Uint8Array());
    if (
      head.code === 128 &&
      /Needed a single revision|unknown revision|bad revision/iu.test(stderr)
    )
      return null;
    return "unavailable";
  }
  const id = decode(head.stdout).trim();
  return /^[0-9a-f]{40}$/u.test(id) ? id : "unavailable";
}

export function parseGitStatus(text: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const record of text.split("\0")) {
    if (record.length < 4) continue;
    const x = record.charAt(0);
    const y = record.charAt(1);
    const path = repositoryRelativePath(record.slice(3));
    if (path === null || x === "!") continue;
    const untracked = x === "?" && y === "?";
    const conflict = CONFLICT_CODES.has(x + y);
    const staged = !untracked && x !== " " && x !== "!";
    const unstaged = !untracked && y !== " " && y !== "!";
    entries.push({ path, staged, unstaged, untracked, conflict });
  }
  return entries;
}

/** Splits a unified diff into before/after sides, ignoring headers and hunk ranges. */
export function parseUnifiedDiff(text: string): { before: string[]; after: string[] } {
  const before: string[] = [];
  const after: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    const mark = line.charAt(0);
    if (mark !== "+" && mark !== "-" && mark !== " ") continue;
    const body = line.slice(1);
    if (mark === "+") after.push(body);
    else if (mark === "-") before.push(body);
    else {
      before.push(body);
      after.push(body);
    }
  }
  return { before, after };
}

/** Applies the per-side and total content caps; returns the possibly truncated text. */
export function capDiffSides(
  before: string,
  after: string,
): { before: string; after: string; truncated: boolean } {
  let truncated = false;
  let cappedBefore = before;
  let cappedAfter = after;
  if (cappedBefore.length > GIT_OBSERVATION_TEXT_SIDE_BYTES) {
    cappedBefore = cappedBefore.slice(0, GIT_OBSERVATION_TEXT_SIDE_BYTES);
    truncated = true;
  }
  if (cappedAfter.length > GIT_OBSERVATION_TEXT_SIDE_BYTES) {
    cappedAfter = cappedAfter.slice(0, GIT_OBSERVATION_TEXT_SIDE_BYTES);
    truncated = true;
  }
  const total = cappedBefore.length + cappedAfter.length;
  if (total > GIT_OBSERVATION_RETURNED_BYTES) {
    const allowance = Math.max(0, GIT_OBSERVATION_RETURNED_BYTES - cappedBefore.length);
    cappedAfter = cappedAfter.slice(0, allowance);
    truncated = true;
  }
  return { before: cappedBefore, after: cappedAfter, truncated };
}

function diffResultFromText(
  text: string,
  capped: boolean,
): Extract<GitChangesResult, { kind: "diff" }> {
  if (text.includes("\0"))
    return { kind: "diff", before: "", after: "", binary: true, truncated: false };
  const { before, after } = parseUnifiedDiff(text);
  const sides = capDiffSides(before.join("\n"), after.join("\n"));
  return {
    kind: "diff",
    before: sides.before,
    after: sides.after,
    binary: false,
    truncated: sides.truncated || capped,
  };
}

async function readStatus(
  runner: GitRunner,
  root: string,
): Promise<Extract<GitChangesResult, { kind: "status" }> | { kind: "unavailable" }> {
  const status = await runGit(runner, root, [
    ...SAFE_CONFIG,
    "status",
    "--porcelain=v1",
    "-z",
    "--no-renames",
    "--untracked-files=normal",
  ]);
  if (status.timedOut || status.code !== 0) return { kind: "unavailable" };
  const entries = parseGitStatus(decode(status.stdout));
  const truncated = status.capped === true || entries.length > GIT_OBSERVATION_MAX_ENTRIES;
  return {
    kind: "status",
    head: null,
    entries: entries.slice(0, GIT_OBSERVATION_MAX_ENTRIES),
    truncated,
  };
}

/**
 * Observes the bot's worktree through the runner. Every command is read-only,
 * fixed-list and bounded; unsafe repository layouts are refused.
 */
export async function observeGitChanges(
  runner: GitRunner,
  request: GitObservationRequest,
): Promise<GitChangesResult> {
  const { root } = request;
  const gitDir = await resolveGitDir(runner, root);
  if (gitDir === "unavailable") return { kind: "unavailable" };
  if (gitDir === null) return { kind: "not-repository" };
  try {
    if (request.assertSafeMetadata) await request.assertSafeMetadata(gitDir);
  } catch {
    return { kind: "unavailable" };
  }
  const head = await resolveHead(runner, root);
  if (head === "unavailable") return { kind: "unavailable" };

  if (request.path === undefined) {
    const status = await readStatus(runner, root);
    return status.kind === "status" ? { ...status, head } : status;
  }

  const path = repositoryRelativePath(request.path);
  if (path === null) return { kind: "unavailable" };
  const status = await readStatus(runner, root);
  if (status.kind !== "status") return status;
  const entry = status.entries.find((item) => item.path === path);
  if (!entry) {
    // Unchanged, deleted after the listing, or beyond the entry cap: no content to show.
    return { kind: "diff", before: "", after: "", binary: false, truncated: status.truncated };
  }
  if (entry.conflict)
    return { kind: "diff", before: null, after: null, binary: false, truncated: false };

  if (entry.untracked) {
    if (!request.readWorktreeFile)
      return { kind: "diff", before: null, after: null, binary: false, truncated: false };
    let bytes: Uint8Array;
    try {
      bytes = await request.readWorktreeFile(path);
    } catch {
      return { kind: "unavailable" };
    }
    return untrackedDiff(bytes);
  }

  const base = head === null ? [] : ["HEAD"];
  const staged = entry.staged && !entry.unstaged;
  const diff = await runGit(
    runner,
    root,
    [
      ...SAFE_CONFIG,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      ...(staged ? ["--cached"] : []),
      ...base,
      "--",
      path,
    ],
    GIT_OBSERVATION_COMMAND_BYTES,
  );
  if (diff.timedOut || diff.code !== 0) return { kind: "unavailable" };
  return diffResultFromText(decode(diff.stdout), diff.capped === true);
}

function untrackedDiff(bytes: Uint8Array): Extract<GitChangesResult, { kind: "diff" }> {
  if (bytes.includes(0))
    return { kind: "diff", before: null, after: "", binary: true, truncated: false };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { kind: "diff", before: null, after: "", binary: true, truncated: false };
  }
  const sides = capDiffSides("", text.replace(/\n$/u, ""));
  return {
    kind: "diff",
    before: null,
    after: sides.after,
    binary: false,
    truncated: sides.truncated,
  };
}
