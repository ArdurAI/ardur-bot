import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DesktopBootSnapshot } from "@ardurbot/contracts";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const BOOT_SNAPSHOT_FILE = "boot-snapshot.json";

/** With nothing saved the window follows the system theme; English is the app's own fallback. */
export const DEFAULT_BOOT_SNAPSHOT: DesktopBootSnapshot = { theme: "system", language: "en" };

const THEMES: readonly DesktopBootSnapshot["theme"][] = ["system", "light", "dark"];
// A BCP 47 language with an optional script and region: `de`, `pt-BR`, `zh-Hans-CN`.
const LANGUAGE_TAG = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/** Keeps exactly the theme and the language, or nothing when either is not a known value. */
export function bootSnapshotFrom(value: unknown): DesktopBootSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const theme = "theme" in value ? value.theme : undefined;
  const language = "language" in value ? value.language : undefined;
  const knownTheme = THEMES.find((known) => known === theme);
  if (knownTheme === undefined || typeof language !== "string" || !LANGUAGE_TAG.test(language))
    return null;
  return { theme: knownTheme, language };
}

/**
 * The theme and language the main window paints before its page loads. The app page keeps it
 * current; it reuses the setup store's bounded reads and atomic, owner-only writes.
 */
export class BootSnapshotStore {
  private snapshot = DEFAULT_BOOT_SNAPSHOT;
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
    return this.snapshot;
  }

  /** Writes a valid snapshot that differs from the current one, in the order they arrive. */
  async save(value: unknown): Promise<boolean> {
    const next = bootSnapshotFrom(value);
    if (
      next === null ||
      (next.theme === this.snapshot.theme && next.language === this.snapshot.language)
    )
      return false;
    const previous = this.snapshot;
    this.snapshot = next;
    const write = this.writes.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writePrivateFile(path.join(this.directory, BOOT_SNAPSHOT_FILE), JSON.stringify(next));
    });
    this.writes = write.catch(() => undefined);
    try {
      await write;
    } catch (error) {
      // Nothing was written, so the same values must not count as saved.
      if (this.snapshot === next) this.snapshot = previous;
      throw error;
    }
    return true;
  }
}
