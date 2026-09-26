import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Matches the board inspector's own budget (`packages/host-runtime/src/board/runner.ts`). */
export const STORAGE_WALK_ENTRY_CAP = 20_000;

export interface DirectorySize {
  bytes: number;
  /** True once the entry cap stopped the walk; `bytes` is then a lower bound. */
  approximate: boolean;
}

/**
 * Sums file sizes under one or more roots without following symlinks, so a link back
 * into the tree (or out of it) cannot be counted twice or walked forever. The cap is
 * shared across every root passed in one call.
 */
export async function directorySize(
  roots: string[],
  cap = STORAGE_WALK_ENTRY_CAP,
): Promise<DirectorySize> {
  let bytes = 0;
  let remaining = cap;
  let approximate = false;

  async function walk(dir: string): Promise<void> {
    if (approximate) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (approximate) return;
      remaining -= 1;
      if (remaining < 0) {
        approximate = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          bytes += (await stat(full)).size;
        } catch {
          // A file removed between readdir and stat; skip it.
        }
      }
    }
  }

  for (const root of roots) {
    if (approximate) break;
    if (existsSync(root)) await walk(root);
  }
  return { bytes, approximate };
}
