import { mkdir } from "node:fs/promises";
import path from "node:path";
import { readPrivateFile, writePrivateFile } from "../setup-store.js";
import type { SystemPreferences } from "./contract.js";
import { defaultPreferences, validPreference } from "./contract.js";

/**
 * menuBarChoice stays null until the owner changes the menu bar.
 * Older files saved every default, so a saved false is not a choice.
 * A saved true without this field is a choice, because the old default was off.
 */
function menuBarChoice(record: Record<string, unknown>): boolean | undefined {
  if (Object.hasOwn(record, "menuBarChoice")) {
    const choice = record.menuBarChoice;
    return choice === true || choice === false ? choice : undefined;
  }
  return record.menuBar === true ? true : undefined;
}

/** Reuses the desktop setup store's bounded reads and atomic, owner-only writes. */
export class SystemStore {
  constructor(
    private readonly directory: string,
    private readonly platform: string = process.platform,
  ) {}

  async read(): Promise<SystemPreferences> {
    return (await this.load()).preferences;
  }

  async write(preferences: SystemPreferences, explicit?: { menuBar: boolean }): Promise<void> {
    const choice = explicit ? explicit.menuBar : (await this.load()).choice;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writePrivateFile(
      path.join(this.directory, "system-settings.json"),
      JSON.stringify({ ...preferences, menuBarChoice: choice ?? null }),
    );
  }

  private async load(): Promise<{
    preferences: SystemPreferences;
    choice: boolean | undefined;
  }> {
    const preferences = defaultPreferences(this.platform);
    const raw = await readPrivateFile(path.join(this.directory, "system-settings.json"), 4096);
    if (!raw) return { preferences, choice: undefined };
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { preferences, choice: undefined };
      }
      const record = value as Record<string, unknown>;
      for (const [key, item] of Object.entries(record)) {
        if (key === "menuBar") continue;
        if (validPreference(key, item)) Object.assign(preferences, { [key]: item });
      }
      const choice = menuBarChoice(record);
      if (typeof choice === "boolean") preferences.menuBar = choice;
      return { preferences, choice };
    } catch {
      return { preferences: defaultPreferences(this.platform), choice: undefined };
    }
  }
}
