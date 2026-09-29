import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DesktopBootSnapshot } from "@ardurbot/contracts";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const BOOT_SNAPSHOT_FILE = "boot-snapshot.json";

/** With nothing saved the window follows the system theme. */
export const DEFAULT_BOOT_SNAPSHOT: DesktopBootSnapshot = { theme: "system" };

const THEMES: readonly DesktopBootSnapshot["theme"][] = ["system", "light", "dark"];

/** Keeps exactly the theme, or nothing when it is not a known value. */
export function bootSnapshotFrom(value: unknown): DesktopBootSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const theme = "theme" in value ? value.theme : undefined;
  const knownTheme = THEMES.find((known) => known === theme);
  if (knownTheme === undefined) return null;
  return { theme: knownTheme };
}

/**
 * The theme the main window paints before its page loads. The app page keeps it
 * current; it reuses the setup store's bounded reads and atomic, owner-only writes.
 */
export class BootSnapshotStore {
  private snapshot = DEFAULT_BOOT_SNAPSHOT;
  private persisted = DEFAULT_BOOT_SNAPSHOT;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  get current(): DesktopBootSnapshot {
    return this.snapshot;
  }

  async load(): Promise<DesktopBootSnapshot> {
    const raw = await readPrivateFile(path.join(this.directory, BOOT_SNAPSHOT_FILE), 1024);
    let saved: unknown = null;
    try {
      saved = raw === null ? null : JSON.parse(raw);
    } catch {
      // An unreadable file means nothing is saved.
    }
    this.snapshot = bootSnapshotFrom(saved) ?? DEFAULT_BOOT_SNAPSHOT;
    this.persisted = this.snapshot;
    return this.snapshot;
  }

  /** Writes a valid snapshot that differs from the current one, in the order they arrive. */
  async save(value: unknown): Promise<boolean> {
    const next = bootSnapshotFrom(value);
    if (next === null || next.theme === this.snapshot.theme) return false;
    this.snapshot = next;
    const write = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writePrivateFile(path.join(this.directory, BOOT_SNAPSHOT_FILE), JSON.stringify(next));
      this.persisted = next;
    });
    this.writes = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      // Nothing was written, so restore the last snapshot actually loaded or written.
      if (this.snapshot === next) this.snapshot = this.persisted;
      throw error;
    }
    return true;
  }
}
