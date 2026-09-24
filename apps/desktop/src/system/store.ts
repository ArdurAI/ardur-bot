import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readPrivateFile, writePrivateFile } from "../setup-store.js";
import type { SystemPreferences } from "./contract.js";
import { DEFAULT_PREFERENCES, validPreference } from "./contract.js";

/** Reuses the desktop setup store's bounded reads and atomic, owner-only writes. */
export class SystemStore {
  constructor(private readonly directory: string) {}

  async read(): Promise<SystemPreferences> {
    const defaults = { ...DEFAULT_PREFERENCES };
    const raw = await readPrivateFile(path.join(this.directory, "system-settings.json"), 4096);
    if (!raw) return defaults;
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) return defaults;
      for (const [key, item] of Object.entries(value)) {
        if (validPreference(key, item)) Object.assign(defaults, { [key]: item });
      }
    } catch {
      return defaults;
    }
    return defaults;
  }

  async write(preferences: SystemPreferences): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writePrivateFile(
      path.join(this.directory, "system-settings.json"),
      JSON.stringify(preferences),
    );
  }
}
