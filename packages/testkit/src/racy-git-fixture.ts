import { createHash } from "node:crypto";
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

/** Force a racily clean stat cache in a single-file, SHA-1 fixture repository. */
export async function forceRacyGitEdit(root: string, relativePath: string, content: string) {
  const index = path.join(root, ".git", "index");
  const file = path.join(root, relativePath);
  const timestamp = await stat(index);
  const bytes = await readFile(index);
  if (
    bytes.toString("ascii", 0, 4) !== "DIRC" ||
    bytes.readUInt32BE(4) !== 2 ||
    bytes.readUInt32BE(8) !== 1 ||
    Buffer.byteLength(content) !== (await stat(file)).size
  ) {
    throw new Error("Expected a single-file, version-2 index and a same-size edit");
  }
  await writeFile(file, content);
  await utimes(file, timestamp.atimeMs / 1000, timestamp.mtimeMs / 1000);
  const edited = await stat(file, { bigint: true });
  // Match cached ctime/mtime exactly so an unrelated stat mismatch cannot detect
  // the edit. Keep the committed blob ID; only Git's racy-clean check can find it.
  for (const [offset, ns] of [
    [12, edited.ctimeNs],
    [20, edited.mtimeNs],
  ] as const) {
    bytes.writeUInt32BE(Number(ns / 1_000_000_000n), offset);
    bytes.writeUInt32BE(Number(ns % 1_000_000_000n), offset + 4);
  }
  const body = bytes.subarray(0, -20);
  await writeFile(index, Buffer.concat([body, createHash("sha1").update(body).digest()]));
  await utimes(index, timestamp.atimeMs / 1000, timestamp.mtimeMs / 1000);
}
