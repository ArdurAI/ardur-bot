import type { Shortcut, ShortcutAction, SystemPreferences } from "./bridge.js";

export type {
  Permission,
  PermissionStatus,
  Shortcut,
  ShortcutAction,
  SystemBridge,
  SystemPreferences,
  SystemState,
} from "./bridge.js";

export const DEFAULT_PREFERENCES: SystemPreferences = {
  runOnStartup: false,
  quickAccess: "Off",
  voice: "Off",
  dictation: "Off",
  menuBar: false,
  keepAwake: false,
  openLinksInBrowser: false,
};
export const SHORTCUT_OPTIONS: Record<ShortcutAction, readonly Shortcut[]> = {
  quickAccess: ["Off", "Alt+Space", "Control+Space"],
  voice: ["Off", "CommandOrControl+Shift+V", "Control+Space"],
  dictation: ["Off", "CommandOrControl+D", "CommandOrControl+Shift+D"],
};

export function validPreference(key: unknown, value: unknown): key is keyof SystemPreferences {
  if (typeof key !== "string" || !Object.hasOwn(DEFAULT_PREFERENCES, key)) return false;
  if (key === "quickAccess" || key === "voice" || key === "dictation")
    return SHORTCUT_OPTIONS[key].some((option) => option === value);
  return typeof value === "boolean";
}
