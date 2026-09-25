import { cp, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const STORAGE_FAILED = "Could not move storage; your original folder is still in use.";
export const STORAGE_RECOVERY_FAILED =
  "Storage recovery needs attention; both copies have been kept.";

export interface StorageBackend {
  /** Includes every data store, including Docker volumes, rather than only Compose configuration. */
  current(): string;
  recommended(): string;
  pick(): Promise<string | null>;
  confirm(destination: string): Promise<boolean>;
  validate(source: string, destination: string): Promise<void>;
  stop(): Promise<void>;
  copy(source: string, destination: string): Promise<void>;
  activate(directory: string): Promise<void>;
  start(): Promise<void>;
  persist(directory: string): Promise<void>;
}

/** Copy, switch and verify before committing; the source remains a recoverable backup. */
export class StorageMove {
  private busy = false;
  private phase: string | null = null;
  constructor(private readonly backend: StorageBackend) {}
  get progress(): string | null {
    return this.phase;
  }

  async move(recommended: boolean): Promise<void> {
    if (this.busy) throw new Error("A storage move is already in progress.");
    this.busy = true;
    try {
      const destination = recommended ? this.backend.recommended() : await this.backend.pick();
      const source = this.backend.current();
      if (!destination || destination === source) return;
      await this.backend.validate(source, destination);
      if (!(await this.backend.confirm(destination))) return;
      let switched = false;
      try {
        this.phase = "Stopping local tasks…";
        await this.backend.stop();
        this.phase = "Moving storage…";
        await this.backend.copy(source, destination);
        switched = true;
        await this.backend.activate(destination);
        this.phase = "Restarting local tasks…";
        await this.backend.start();
        await this.backend.persist(destination);
      } catch {
        this.phase = "Restoring the original folder…";
        try {
          if (switched) await this.backend.stop();
          await this.backend.activate(source);
          await this.backend.start();
          await this.backend.persist(source);
        } catch {
          throw new Error(STORAGE_RECOVERY_FAILED);
        }
        // Never recursively remove a picker path: another process may have replaced it.
        // Retain the partial destination for explicit inspection/recovery.
        throw new Error(STORAGE_FAILED);
      }
    } finally {
      this.busy = false;
      this.phase = null;
    }
  }
}

/** The picker selects a parent; only a new, app-owned child can be a migration destination. */
export async function validateStorageDestination(
  source: string,
  destination: string,
): Promise<void> {
  if (
    !path.isAbsolute(source) ||
    !path.isAbsolute(destination) ||
    path.parse(destination).root === destination
  )
    throw new Error("Choose a dedicated storage folder.");
  const sourcePath = await realpath(source);
  const parent = await realpath(path.dirname(destination));
  const next = path.join(parent, path.basename(destination));
  const relative = path.relative(sourcePath, next);
  const reverse = path.relative(next, sourcePath);
  if (
    !relative ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) ||
    (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse))
  )
    throw new Error("Choose a folder outside the current storage folder.");
  try {
    await lstat(next);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Choose a new storage folder.");
}

/** Local files only; callers must separately migrate named volumes before exposing Change. */
export async function copyStorageDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { mode: 0o700 });
  const entries = await readdir(source);
  for (const entry of entries) {
    await cp(path.join(source, entry), path.join(destination, entry), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
  }
}
