import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  access,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  HomeArchiveFile,
  PortableFile,
} from "@ardurbot/adapter-kit";
import { fileHandlePath } from "./file-handle-path.js";

/** A path would leave the bot home or the workspace root being written inside. */
export class HomeContainmentError extends Error {}

export class LocalAgentHomeStore implements AgentHomeStore {
  private readonly botWrites = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  describe() {
    return {
      id: "local-fs",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { revisions: false },
    };
  }

  private botDir(botId: string) {
    if (!botId || botId === "." || botId === ".." || path.basename(botId) !== botId) {
      throw new Error("Invalid bot id");
    }
    return path.join(this.root, "homes", botId);
  }

  pathFor(botId: string) {
    return path.resolve(this.botDir(botId));
  }

  async checkout(botId: string, dest: string, _context: AdapterContext): Promise<string> {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    await mkdir(dest, { recursive: true });
    const src = this.botDir(botId);
    await mkdir(src, { recursive: true });
    await copyDir(src, dest);
    return "working";
  }

  async commit(botId: string, src: string, _context: AdapterContext): Promise<string> {
    return this.withBotWrite(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      const dest = this.botDir(botId);
      const parent = path.dirname(dest);
      const staging = path.join(parent, `.${botId}.staging-${randomUUID()}`);
      const previous = `${dest}.previous`;
      await mkdir(parent, { recursive: true });
      await mkdir(staging, { recursive: true });
      try {
        await copyDir(src, staging);
        await rm(previous, { recursive: true, force: true });
        if (await pathExists(dest)) await rename(dest, previous);
        try {
          await rename(staging, dest);
        } catch (error) {
          if (!(await pathExists(dest)) && (await pathExists(previous))) {
            await rename(previous, dest).catch(() => undefined);
          }
          throw error;
        }
        await rm(previous, { recursive: true, force: true });
        return this.writeRevision(botId);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  async revise(botId: string): Promise<string> {
    return this.withBotWrite(botId, async () => this.writeRevision(botId));
  }

  async restore(
    botId: string,
    _revision: string,
    dest: string,
    context: AdapterContext,
  ): Promise<void> {
    await this.checkout(botId, dest, context);
  }

  async *exportHome(botId: string, _context: AdapterContext): AsyncIterable<PortableFile> {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    const dir = this.botDir(botId);
    await mkdir(dir, { recursive: true });
    const root = await realpath(dir);
    yield* walkFiles(root, root);
  }

  async *streamHome(
    homeKey: string,
    context: AdapterContext,
    exclude: (path: string) => boolean,
  ): AsyncIterable<HomeArchiveFile> {
    await this.waitForBotWrite(homeKey);
    await this.recoverInterruptedCommit(homeKey);
    const dir = this.botDir(homeKey);
    await mkdir(dir, { recursive: true });
    const root = await realpath(dir);
    yield* streamHomeFiles(root, root, context.signal, exclude);
  }

  async readFile(
    botId: string,
    filePath: string,
    _context: AdapterContext,
    options?: { maxBytes?: number; preview?: boolean },
  ): Promise<string> {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    const full = await containedExistingPath(this.botDir(botId), filePath);
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (options?.maxBytes !== undefined) {
        const info = await handle.stat();
        if (info.size > options.maxBytes && !options.preview) {
          throw new Error(`agent home file exceeds ${options.maxBytes} bytes`);
        }
      }
      if (options?.preview && options.maxBytes !== undefined) {
        const buffer = Buffer.alloc(options.maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead), {
            stream: bytesRead === buffer.length,
          });
        } catch {
          throw new Error("Binary file");
        }
      }
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  }

  async writeFile(
    botId: string,
    filePath: string,
    content: string,
    _context: AdapterContext,
  ): Promise<void> {
    await this.withBotWrite(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      const full = await containedWritePath(this.botDir(botId), filePath);
      const handle = await open(
        full,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o666,
      );
      try {
        await handle.writeFile(content, "utf8");
      } finally {
        await handle.close();
      }
    });
  }

  /**
   * Write inside a narrower workspace root within the bot home. The boundary
   * check and the write hold the same per-bot write lock, so a concurrent
   * commit cannot rename a swapped directory into place between them, and the
   * content lands in a temporary file inside the verified real directory
   * before a rename onto the target, which replaces a swapped-in symlink
   * instead of following it.
   */
  async writeFileInsideRoot(
    botId: string,
    workspaceRoot: string,
    filePath: string,
    content: string,
    _context: AdapterContext,
  ): Promise<void> {
    return this.withBotWrite(botId, async () => {
      await this.recoverInterruptedCommit(botId);
      const dir = this.botDir(botId);
      await mkdir(dir, { recursive: true });
      const homeDir = await realpath(dir);
      const boundary = await confinedRootDirectory(homeDir, workspaceRoot);
      const canonical = await realpath(boundary);
      const relative = path.posix.relative(
        workspaceRoot.replaceAll("\\", "/") || ".",
        filePath.replaceAll("\\", "/"),
      );
      if (
        !relative ||
        relative === "." ||
        relative.startsWith("..") ||
        path.posix.isAbsolute(relative)
      )
        throw new HomeContainmentError("Path escapes the bot workspace");
      const parts = relative.split("/").filter(Boolean);
      const name = parts.at(-1)!;
      const directory = await confinedWriteDirectory(canonical, parts.slice(0, -1));
      const target = path.join(directory, name);
      // The temp file starts with the umask default; a replaced file keeps
      // its mode, applied after the containment check below.
      let mode: number | undefined;
      try {
        const existing = await lstat(target);
        // A symlink is never followed; refuse it so the writer decides.
        if (existing.isSymbolicLink() || !existing.isFile())
          throw new HomeContainmentError("Path escapes the bot workspace");
        mode = existing.mode & 0o777;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      const temporary = path.join(directory, `.${name}.tmp-${randomUUID()}`);
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o666,
      );
      try {
        // The verified pathname can lie if an ancestor was replaced; check
        // the opened object itself before any content reaches it.
        assertWorkspaceContained(canonical, await fileHandlePath(handle.fd));
        if (mode !== undefined) await handle.chmod(mode);
        await handle.writeFile(content, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      await handle.close();
      try {
        await rename(temporary, target);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
  }

  async list(botId: string, dirPath: string, _context: AdapterContext) {
    await this.waitForBotWrite(botId);
    await this.recoverInterruptedCommit(botId);
    const root = this.botDir(botId);
    const candidate = safeJoin(root, dirPath);
    const full = await ensureContainedDirectory(root, candidate);
    const entries = await readdir(full, { withFileTypes: true });
    const listed = await Promise.all(
      entries.map(async (entry) => {
        const child = await containedTarget(root, path.join(full, entry.name)).catch(() => null);
        if (!child) return null;
        const info = await stat(child);
        return {
          path: path.posix.join(dirPath.replace(/\\/g, "/"), entry.name),
          kind: info.isDirectory() ? ("dir" as const) : ("file" as const),
          size: info.size,
        };
      }),
    );
    return listed.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  }

  private async writeRevision(botId: string) {
    const revision = `rev-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const directory = path.join(this.root, "home-revisions");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${botId}.txt`), revision, "utf8");
    return revision;
  }

  private async recoverInterruptedCommit(botId: string) {
    const dest = this.botDir(botId);
    const previous = `${dest}.previous`;
    if (!(await pathExists(dest)) && (await pathExists(previous))) await rename(previous, dest);
  }

  private async withBotWrite<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.botWrites.get(botId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Keep the chain alive even when a prior write rejects, so later writers are not stuck
    // behind a permanently rejected predecessor.
    const queued = previous.catch(() => undefined).then(() => current);
    this.botWrites.set(botId, queued);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      release();
      if (this.botWrites.get(botId) === queued) this.botWrites.delete(botId);
    }
  }

  private async waitForBotWrite(botId: string) {
    await (this.botWrites.get(botId) ?? Promise.resolve());
  }
}

export function resolveAgentHomePath(home: AgentHomeStore, homeKey: string, dataDir = "./data") {
  if (home instanceof LocalAgentHomeStore) return home.pathFor(homeKey);
  return path.resolve(dataDir, "homes", homeKey);
}

function safeJoin(root: string, rel: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${path.sep}${rel.replace(/^\/+/, "")}`);
  assertContained(resolvedRoot, resolved);
  return resolved;
}

async function containedExistingPath(root: string, rel: string) {
  await mkdir(root, { recursive: true });
  const candidate = safeJoin(root, rel);
  return containedTarget(root, candidate);
}

async function containedWritePath(root: string, rel: string) {
  await mkdir(root, { recursive: true });
  const candidate = safeJoin(root, rel);
  const resolvedParent = await ensureContainedDirectory(root, path.dirname(candidate));
  try {
    return await containedTarget(root, path.join(resolvedParent, path.basename(candidate)));
  } catch (error) {
    if (isMissing(error)) return path.join(resolvedParent, path.basename(candidate));
    throw error;
  }
}

async function ensureContainedDirectory(root: string, candidate: string) {
  await mkdir(root, { recursive: true });
  const lexicalRoot = path.resolve(root);
  const lexicalCandidate = path.resolve(candidate);
  assertContained(lexicalRoot, lexicalCandidate);
  const resolvedRoot = await realpath(root);
  const relative = path.relative(lexicalRoot, lexicalCandidate);
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const next = path.join(current, segment);
    try {
      current = await realpath(next);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(next);
      current = await realpath(next);
    }
    assertContained(resolvedRoot, current);
    if (!(await stat(current)).isDirectory()) throw new Error("Path component is not a directory");
  }
  return current;
}

async function containedTarget(root: string, candidate: string) {
  const [resolvedRoot, resolvedTarget] = await Promise.all([realpath(root), realpath(candidate)]);
  assertContained(resolvedRoot, resolvedTarget);
  return resolvedTarget;
}

function assertContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  )
    return;
  throw new Error("Path escapes the bot home");
}

function assertWorkspaceContained(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  )
    return;
  throw new HomeContainmentError("Path escapes the bot workspace");
}

/**
 * Resolve the workspace root inside the bot home. Every existing component
 * must be a real directory: a symlinked boundary could be retargeted by a
 * later commit, so it is refused rather than followed. Missing components are
 * created inside the verified parent.
 */
async function confinedRootDirectory(homeDir: string, workspaceRoot: string) {
  const parts = workspaceRoot.replaceAll("\\", "/").split("/").filter(Boolean);
  const lexical = path.resolve(homeDir, ...parts);
  assertWorkspaceContained(homeDir, lexical);
  let current = homeDir;
  for (const part of parts) {
    if (part === "." || part === "..")
      throw new HomeContainmentError("Path escapes the bot workspace");
    const next = path.join(current, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(next);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(next);
      current = next;
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new HomeContainmentError("Path escapes the bot workspace");
    current = next;
  }
  return current;
}

/**
 * Resolve the directory that will hold the written file. An in-boundary
 * symlink is followed once, to its verified real target; anything resolving
 * outside the workspace root is refused. Missing directories are created
 * inside the verified parent.
 */
async function confinedWriteDirectory(canonicalBoundary: string, parts: string[]) {
  let current = canonicalBoundary;
  for (const part of parts) {
    if (part === "." || part === "..")
      throw new HomeContainmentError("Path escapes the bot workspace");
    const next = path.join(current, part);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(next);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(next);
      current = next;
      continue;
    }
    if (info.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = await realpath(next);
      } catch (error) {
        if (isMissing(error)) throw new HomeContainmentError("Path escapes the bot workspace");
        throw error;
      }
      assertWorkspaceContained(canonicalBoundary, resolved);
      if (!(await stat(resolved)).isDirectory())
        throw new HomeContainmentError("Path escapes the bot workspace");
      current = resolved;
      continue;
    }
    if (!info.isDirectory()) throw new HomeContainmentError("Path escapes the bot workspace");
    current = next;
  }
  return current;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(target: string) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function traversalTarget(root: string, candidate: string) {
  const resolved = await realpath(candidate);
  assertContained(root, resolved);
  return resolved;
}

async function readTraversalFile(root: string, full: string) {
  const handle = await open(
    full,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Home entry is not a regular file");
    // O_NOFOLLOW only protects the final component. A parent can be swapped
    // during open and restored before any pathname recheck. Check the actual
    // opened object against the root captured once for the entire traversal.
    assertContained(root, await fileHandlePath(handle.fd));
    return { content: await handle.readFile(), mode: info.mode };
  } finally {
    await handle.close();
  }
}

async function copyDir(
  src: string,
  dest: string,
  sourceRoot?: string,
  visited = new Set<string>(),
) {
  const root = sourceRoot ?? (await realpath(src));
  const current = await traversalTarget(root, src).catch(() => null);
  if (!current || visited.has(current)) return;
  await mkdir(dest, { recursive: true });
  visited.add(current);
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const from = await traversalTarget(root, path.join(current, entry.name)).catch(() => null);
    if (!from) continue;
    const to = path.join(dest, entry.name);
    const info = await stat(from);
    if (info.isDirectory()) await copyDir(from, to, root, visited);
    else if (info.isFile()) {
      const file = await readTraversalFile(root, from);
      await writeFile(to, file.content, { mode: file.mode & 0o777 });
    }
  }
}

async function* walkFiles(
  root: string,
  current: string,
  outputPath = "",
  visited = new Set<string>(),
): AsyncGenerator<PortableFile> {
  const resolvedCurrent = await traversalTarget(root, current).catch(() => null);
  if (!resolvedCurrent || visited.has(resolvedCurrent)) return;
  visited.add(resolvedCurrent);
  const entries = await readdir(resolvedCurrent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = await traversalTarget(root, path.join(resolvedCurrent, entry.name)).catch(
      () => null,
    );
    if (!full) continue;
    const info = await stat(full);
    const portablePath = path.posix.join(outputPath, entry.name);
    if (info.isDirectory()) {
      yield* walkFiles(root, full, portablePath, visited);
    } else if (info.isFile()) {
      const { content, mode } = await readTraversalFile(root, full);
      yield {
        path: portablePath,
        content: new Uint8Array(content),
        executable: Boolean(mode & 0o100),
      };
    }
  }
}

/**
 * A read stream that stops with the download and never crashes the process: a cancel
 * between the stream's creation and its first read would otherwise emit an error with no
 * listener. The error still reaches whoever reads the stream.
 */
function abortSafeReadStream(handle: FileHandle, size: number, signal: AbortSignal) {
  const stream = handle.createReadStream({
    autoClose: false,
    highWaterMark: 64 * 1024,
    end: size - 1,
    signal,
  });
  stream.on("error", () => {});
  return stream;
}

async function* streamHomeFiles(
  root: string,
  current: string,
  signal: AbortSignal,
  exclude: (path: string) => boolean,
  outputPath = "",
  visited = new Set<string>(),
): AsyncGenerator<HomeArchiveFile> {
  const resolved = await traversalTarget(root, current);
  if (visited.has(resolved)) return;
  visited.add(resolved);
  for (const entry of await readdir(resolved, { withFileTypes: true })) {
    signal.throwIfAborted();
    const portablePath = path.posix.join(outputPath, entry.name);
    if (exclude(portablePath)) continue;
    const full = await traversalTarget(root, path.join(resolved, entry.name)).catch(() => null);
    if (!full || exclude(path.relative(root, full).split(path.sep).join("/"))) continue;
    const entryInfo = await stat(full);
    if (entryInfo.isDirectory()) {
      yield* streamHomeFiles(root, full, signal, exclude, portablePath, visited);
      continue;
    }
    if (!entryInfo.isFile()) continue;
    const handle = await open(
      full,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) continue;
      assertContained(root, await fileHandlePath(handle.fd));
      // The download can be cancelled while the file was being opened. A stream created
      // under a signal that is already aborted destroys itself with an error at once, and
      // an error on a stream nobody listens to yet takes the whole process down.
      signal.throwIfAborted();
      yield {
        path: portablePath,
        size: info.size,
        executable: Boolean(info.mode & 0o100),
        content: info.size
          ? abortSafeReadStream(handle, info.size, signal)
          : (async function* () {})(),
      };
    } finally {
      await handle.close();
    }
  }
}
