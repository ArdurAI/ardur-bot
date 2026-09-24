import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

export const BUNDLE_MAX_BYTES = 64 * 1024 * 1024;
export const BUNDLE_MAX_FILES = 10_000;
export const DOCUMENT_MAX_BYTES = 128 * 1024;

export interface BundleFile {
  path: string;
  bytes: Uint8Array;
  executable?: boolean;
}

/** Use portable names so a bundle has the same containment rules on every OS. */
export function bundlePath(value: string): string {
  const name = value.replace(/^\.\//, "");
  if (
    !name ||
    name.length > 1024 ||
    /[\\:]/u.test(name) ||
    Array.from(name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    name.startsWith("/") ||
    name
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("The bundle contains an unsafe file path.");
  return name;
}

export function validateBundleFiles(files: readonly BundleFile[]): void {
  if (!files.length || files.length > BUNDLE_MAX_FILES)
    throw new Error("The bundle has too many files or is empty.");
  let size = 0;
  const names = new Set<string>();
  for (const file of files) {
    const name = bundlePath(file.path).toLowerCase();
    if (names.has(name)) throw new Error("The bundle contains duplicate file paths.");
    names.add(name);
    size += file.bytes.byteLength;
    if (size > BUNDLE_MAX_BYTES) throw new Error("The bundle is too large.");
  }
  for (const name of names) {
    const parts = name.split("/");
    parts.pop();
    while (parts.length) {
      if (names.has(parts.join("/"))) throw new Error("A bundle file replaces a directory.");
      parts.pop();
    }
  }
}

/** The caller supplies a fresh, private staging directory, never an existing install. */
export async function writeBundleFiles(directory: string, files: readonly BundleFile[]) {
  validateBundleFiles(files);
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const file of files) {
      const target = path.join(directory, bundlePath(file.path));
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const handle = await open(target, "wx", file.executable ? 0o700 : 0o600);
      try {
        await handle.writeFile(file.bytes);
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Native folder selection grants a snapshot, not continuing access to symlink targets. */
export async function readBundleFolder(directory: string): Promise<BundleFile[]> {
  const root = await realpath(directory);
  const files: BundleFile[] = [];
  let size = 0;
  let entries = 0;
  async function visit(relative: string, depth: number) {
    if (depth > 32) throw new Error("The folder is too deeply nested.");
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      if (++entries > BUNDLE_MAX_FILES) throw new Error("The folder has too many files.");
      const name = bundlePath(relative ? `${relative}/${entry.name}` : entry.name);
      const target = path.join(root, name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) throw new Error("Choose a folder without symbolic links.");
      if (stat.isDirectory()) {
        const resolved = await realpath(target);
        if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error("The folder changed.");
        await visit(name, depth + 1);
      } else if (stat.isFile()) {
        if (stat.size > BUNDLE_MAX_BYTES - size) throw new Error("The folder is too large.");
        const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const current = await handle.stat();
          if (!current.isFile() || current.size > BUNDLE_MAX_BYTES - size)
            throw new Error("The folder is too large.");
          const bytes = new Uint8Array(current.size);
          let offset = 0;
          while (offset < bytes.length) {
            const read = await handle.read(bytes, offset, bytes.length - offset, offset);
            if (!read.bytesRead) throw new Error("The folder changed.");
            offset += read.bytesRead;
          }
          size += bytes.length;
          files.push({ path: name, bytes, executable: (current.mode & 0o111) !== 0 });
        } finally {
          await handle.close();
        }
      } else throw new Error("The folder contains an unsupported file.");
    }
  }
  await visit("", 0);
  validateBundleFiles(files);
  return files;
}

export function bundleDocument(files: readonly BundleFile[], name: string): string | undefined {
  const file = files.find((entry) => entry.path === name);
  if (!file) return undefined;
  if (file.bytes.byteLength > DOCUMENT_MAX_BYTES) throw new Error("The document is too large.");
  return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
}
