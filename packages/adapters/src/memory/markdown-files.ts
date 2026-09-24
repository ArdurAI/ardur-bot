import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { DocumentRevision } from "@ardurbot/adapter-kit";
import { MemoryConflictError } from "@ardurbot/adapter-kit";
import { DocumentRevisionSchema } from "@ardurbot/contracts";
import { assertMemoryPath, assertMemorySafe } from "@ardurbot/memory";

export type MemoryFilesystem = Pick<
  typeof fs,
  "lstat" | "realpath" | "mkdir" | "open" | "rename" | "unlink" | "readdir"
>;
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function historyNotePath(revision: DocumentRevision, writer = ""): string {
  const stamp = revision.createdAt.replace(/[:.]/gu, "-");
  return `history/${revision.documentId}/${writer ? `${writer}-` : ""}${String(revision.revision).padStart(8, "0")}-${stamp}.md`;
}

/** JSON values are YAML flow values: no YAML tags, aliases, executable types, or parser dependency. */
export function revisionMarkdown(revision: DocumentRevision): string {
  const { content } = revision;
  const metadata = {
    id: revision.documentId,
    scope: revision.scopeKey,
    author: revision.author,
    ...(revision.learning ? { learning: revision.learning } : {}),
    bot:
      revision.author.botId ?? (revision.scopeKey.kind === "bot" ? revision.scopeKey.botId : null),
    runId: revision.runId,
    threadId: revision.threadId,
    model: revision.model,
    references: revision.references,
    revision: revision.revision,
    updatedAt: revision.createdAt,
    path: revision.path,
    deletedAt: revision.deletedAt,
    ...(revision.commitId ? { commitId: revision.commitId } : {}),
  };
  return `---\n${Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")}\n---\n${content}`;
}
export function parseRevisionMarkdown(text: string): DocumentRevision {
  assertMemorySafe(text);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(text);
  if (!match) throw new Error("Keep the memory note frontmatter when editing.");
  const metadata: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^(\w+):\s*(.*)$/u.exec(line);
    if (!field || Object.hasOwn(metadata, field[1]!))
      throw new Error("Invalid memory frontmatter.");
    // Generated scalars remain readable and editable; structured values use YAML's JSON subset.
    const value = field[2]!;
    try {
      metadata[field[1]!] = JSON.parse(value);
    } catch {
      metadata[field[1]!] = value;
    }
  }
  const { id, scope, bot: _bot, updatedAt, ...rest } = metadata;
  return DocumentRevisionSchema.parse({
    ...rest,
    documentId: id,
    scopeKey: scope,
    createdAt: updatedAt,
    content: match[2]!,
  });
}

/** All IO is rooted in an explicitly registered dedicated folder, never a bot filesystem. */
export class MarkdownFiles {
  constructor(
    readonly root: string,
    private readonly filesystem: MemoryFilesystem = fs,
  ) {}
  async validateRoot(): Promise<void> {
    if (!path.isAbsolute(this.root) || path.parse(this.root).root === this.root)
      throw new Error("Choose a dedicated memory folder.");
    const parts = path.resolve(this.root).split(path.sep).filter(Boolean);
    let at = path.parse(this.root).root;
    for (const part of parts) {
      at = path.join(at, part);
      const info = await this.filesystem.lstat(at);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Memory folders cannot contain symbolic links.");
    }
  }
  async resolve(relative: string, createParents = false): Promise<string> {
    assertMemoryPath(relative);
    await this.validateRoot();
    const parts = relative.split("/");
    let at = this.root;
    for (const [index, part] of parts.entries()) {
      at = path.join(at, part);
      try {
        const stat = await this.filesystem.lstat(at);
        if (
          stat.isSymbolicLink() ||
          (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() && !stat.isDirectory())
        )
          throw new Error("Memory paths cannot contain symbolic links or special files.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (index < parts.length - 1 && createParents)
          await this.filesystem.mkdir(at, { mode: 0o700 });
      }
    }
    return at;
  }
  async read(relative: string): Promise<string | null> {
    const file = await this.resolve(relative);
    let handle: FileHandle | undefined;
    try {
      handle = await this.filesystem.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > 25_000_000)
        throw new Error("This memory file is too large or is not a regular file.");
      return await handle.readFile("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    } finally {
      await handle?.close();
    }
  }
  async write(
    relative: string,
    text: string,
    scan = true,
    expected?: string | null,
  ): Promise<void> {
    if (scan) assertMemorySafe({ filename: relative, text });
    const destination = await this.resolve(relative, true);
    const temporary = `${relative}.${randomUUID()}.tmp`;
    const tempPath = await this.resolve(temporary);
    const handle = await this.filesystem.open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Recheck containment immediately before rename. OS permissions are the boundary against
      // a hostile local process swapping ancestor directories during IO; never grant bots access.
      await this.resolve(relative);
      if (expected !== undefined && (await this.read(relative)) !== expected)
        throw new MemoryConflictError();
      await this.filesystem.rename(tempPath, destination);
      const directory = await this.filesystem.open(path.dirname(destination), constants.O_RDONLY);
      try {
        await directory.sync();
      } catch (error) {
        if (!["EINVAL", "EPERM", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      } finally {
        await directory.close();
      }
    } finally {
      await this.filesystem.unlink(tempPath).catch(() => undefined);
    }
  }
  async remove(relative: string, expected?: string | null) {
    const file = await this.resolve(relative);
    if (expected !== undefined && (await this.read(relative)) !== expected)
      throw new MemoryConflictError();
    await this.filesystem.unlink(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  async ensureDirectory(relative: string) {
    await this.resolve(`${relative}/.directory`, true);
  }
}
