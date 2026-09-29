import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const BLOCK = 512;

export class HermesArchiveError extends Error {
  constructor(message = "archive refused") {
    super(message);
    this.name = "HermesArchiveError";
  }
}

type TarKind = "file" | "dir" | "skip" | "refuse";

type TarEntry = {
  kind: TarKind;
  path: string;
  mode: number;
  data: Buffer;
};

export function gunzipLimited(bytes: Buffer, maxOutputLength: number): Buffer {
  try {
    return gunzipSync(bytes, { maxOutputLength });
  } catch {
    throw new HermesArchiveError();
  }
}

/** Git blob id: sha1("blob <len>\\0" + bytes). */
export function gitBlobId(data: Buffer): string {
  return createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
}

/**
 * Git tree id. Directory names sort as "name/" so the order matches `git write-tree`.
 * Directory mode is "40000"; files are "100644" or "100755".
 */
export function gitTreeObject(entries: { mode: string; name: string; id: string }[]): string {
  const sorted = [...entries].sort((left, right) => Buffer.compare(sortKey(left), sortKey(right)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"));
    parts.push(Buffer.from(entry.id, "hex"));
  }
  const body = Buffer.concat(parts);
  return createHash("sha1").update(`tree ${body.length}\0`).update(body).digest("hex");
}

function sortKey(entry: { mode: string; name: string }): Buffer {
  const name = entry.mode === "40000" ? `${entry.name}/` : entry.name;
  return Buffer.from(name, "utf8");
}

/** Hash a directory the way git hashes a tree. Empty directories are omitted. */
export async function gitTreeHash(directory: string): Promise<string> {
  const id = await hashTree(directory);
  if (!id) throw new HermesArchiveError();
  return id;
}

async function hashTree(directory: string): Promise<string | null> {
  const names = await readdir(directory);
  const entries: { mode: string; name: string; id: string }[] = [];
  for (const name of names) {
    const full = path.join(directory, name);
    const stat = await lstat(full);
    if (stat.isSymbolicLink()) throw new HermesArchiveError();
    if (stat.isDirectory()) {
      const child = await hashTree(full);
      if (!child) continue;
      entries.push({ mode: "40000", name, id: child });
      continue;
    }
    if (!stat.isFile()) throw new HermesArchiveError();
    const data = await readFile(full);
    const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
    entries.push({ mode, name, id: gitBlobId(data) });
  }
  if (entries.length === 0) return null;
  return gitTreeObject(entries);
}

export async function extractSourceArchive(
  gzip: Buffer,
  dest: string,
  limits: { files: number; bytes: number; inflated: number },
): Promise<void> {
  const tar = gunzipLimited(gzip, limits.inflated);
  await mkdir(dest, { recursive: true, mode: 0o755 });
  let files = 0;
  let bytes = 0;
  let top: string | undefined;
  for (const entry of readTar(tar)) {
    if (entry.kind === "skip") continue;
    if (entry.kind === "refuse") throw new HermesArchiveError();
    const relative = stripTop(entry.path, entry.kind, (name) => {
      if (top === undefined) top = name;
      else if (top !== name) throw new HermesArchiveError();
    });
    if (relative === null) continue;
    if (entry.kind === "file") {
      files += 1;
      bytes += entry.data.length;
      if (files > limits.files || bytes > limits.bytes) throw new HermesArchiveError();
      const target = inside(dest, relative);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, entry.data, { mode: entry.mode, flag: "wx" });
      await chmod(target, entry.mode);
      continue;
    }
    files += 1;
    if (files > limits.files) throw new HermesArchiveError();
    const target = inside(dest, relative);
    await mkdir(target, { recursive: true, mode: entry.mode });
    await chmod(target, entry.mode);
  }
  if (files === 0) throw new HermesArchiveError();
}

export async function extractUvBinary(
  gzip: Buffer,
  destFile: string,
  inflated: number,
): Promise<void> {
  const tar = gunzipLimited(gzip, inflated);
  let binary: Buffer | undefined;
  for (const entry of readTar(tar)) {
    if (entry.kind === "skip") continue;
    if (path.posix.basename(entry.path) !== "uv") continue;
    if (entry.kind !== "file") throw new HermesArchiveError();
    if (binary) throw new HermesArchiveError();
    binary = entry.data;
  }
  if (!binary) throw new HermesArchiveError();
  await mkdir(path.dirname(destFile), { recursive: true, mode: 0o755 });
  await writeFile(destFile, binary, { mode: 0o755 });
  await chmod(destFile, 0o755);
}

function stripTop(entryPath: string, kind: TarKind, observe: (top: string) => void): string | null {
  const parts = safeParts(entryPath);
  observe(parts[0] ?? "");
  const rest = parts.slice(1);
  if (rest.length === 0) {
    if (kind !== "dir") throw new HermesArchiveError();
    return null;
  }
  return rest.join("/");
}

function safeParts(entryPath: string): string[] {
  if (entryPath.includes("\0") || entryPath.includes("\\") || entryPath.startsWith("/"))
    throw new HermesArchiveError();
  const trimmed = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
  if (trimmed === "") throw new HermesArchiveError();
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    throw new HermesArchiveError();
  return parts;
}

function inside(dest: string, relative: string): string {
  const target = path.resolve(dest, relative);
  const remainder = path.relative(dest, target);
  if (remainder === "" || remainder.startsWith("..") || path.isAbsolute(remainder))
    throw new HermesArchiveError();
  return target;
}

function* readTar(tar: Buffer): Generator<TarEntry> {
  let offset = 0;
  const global = new Map<string, string>();
  let pending = new Map<string, string>();
  let gnuName: string | undefined;
  let gnuLink: string | undefined;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((byte) => byte === 0)) return;
    if (!checksumOk(header)) throw new HermesArchiveError();
    const size = readOctal(header, 124, 12);
    const data = tar.subarray(offset, offset + size);
    if (data.length !== size) throw new HermesArchiveError();
    offset += BLOCK * Math.ceil(size / BLOCK);
    const type = header[156] ?? 0;
    const flag = type === 0 ? "0" : String.fromCharCode(type);
    if (flag === "g" || flag === "x") {
      const records = parsePax(data);
      if (flag === "g") {
        for (const [key, value] of records) global.set(key, value);
      } else pending = records;
      continue;
    }
    if (flag === "L") {
      gnuName = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (flag === "K") {
      gnuLink = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    const metaPath = pending.get("path") ?? gnuName ?? global.get("path");
    const metaLink = pending.get("linkpath") ?? gnuLink ?? global.get("linkpath");
    const metaSize = pending.get("size") ?? global.get("size");
    pending = new Map();
    gnuName = undefined;
    gnuLink = undefined;
    const entryPath = metaPath || ustarPath(header);
    if (metaSize !== undefined && Number.parseInt(metaSize, 10) !== size)
      throw new HermesArchiveError();
    const mode = readOctal(header, 100, 8) & 0o777;
    const linkName = metaLink || field(header, 157, 100);
    if (flag === "1" || flag === "2" || flag === "3" || flag === "4" || flag === "6") {
      yield { kind: "refuse", path: entryPath, mode, data: Buffer.alloc(0) };
      continue;
    }
    if (linkName) {
      yield { kind: "refuse", path: entryPath, mode, data: Buffer.alloc(0) };
      continue;
    }
    if (flag !== "0" && flag !== "5") {
      yield { kind: "refuse", path: entryPath, mode, data: Buffer.alloc(0) };
      continue;
    }
    // git archive uses the umask (0664/0775), so normalize: any execute bit means 0o755,
    // anything else 0o644, directories always 0o755, special bits never survive.
    yield {
      kind: flag === "5" ? "dir" : "file",
      path: entryPath,
      mode: flag === "5" ? 0o755 : (mode & 0o111) !== 0 ? 0o755 : 0o644,
      data: flag === "5" ? Buffer.alloc(0) : Buffer.from(data),
    };
  }
}

function ustarPath(header: Buffer): string {
  const name = field(header, 0, 100);
  const prefix = field(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw
    .subarray(0, end === -1 ? raw.length : end)
    .toString("utf8")
    .replace(/ +$/, "");
}

function readOctal(header: Buffer, offset: number, length: number): number {
  const text = header
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0[\s\S]*$/, "")
    .trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new HermesArchiveError();
  return Number.parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  const stored = readOctal(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : (header[index] ?? 0);
  }
  return sum === stored;
}

function parsePax(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    if (body[offset] === 0) break;
    let space = offset;
    while (space < body.length && body[space] !== 32) space += 1;
    if (space >= body.length) throw new HermesArchiveError();
    const digits = body.subarray(offset, space).toString("ascii");
    if (!/^[0-9]+$/.test(digits)) throw new HermesArchiveError();
    const length = Number.parseInt(digits, 10);
    if (!Number.isInteger(length) || length < digits.length + 3 || offset + length > body.length)
      throw new HermesArchiveError();
    const record = body.subarray(offset, offset + length);
    if (record[record.length - 1] !== 10) throw new HermesArchiveError();
    const content = record.subarray(digits.length + 1, record.length - 1);
    const eq = content.indexOf(0x3d);
    if (eq <= 0) throw new HermesArchiveError();
    records.set(
      content.subarray(0, eq).toString("utf8"),
      content.subarray(eq + 1).toString("utf8"),
    );
    offset += length;
  }
  return records;
}
