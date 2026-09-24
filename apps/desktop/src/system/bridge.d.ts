/** Serializable machine settings; no Electron objects or credentials cross the bridge. */
export type ShortcutAction = "quickAccess" | "voice" | "dictation";
export type Shortcut =
  | "Off"
  | "Alt+Space"
  | "Control+Space"
  | "CommandOrControl+Shift+V"
  | "CommandOrControl+Shift+D"
  | "CommandOrControl+D";
export interface SystemPreferences {
  runOnStartup: boolean;
  quickAccess: Shortcut;
  voice: Shortcut;
  dictation: Shortcut;
  menuBar: boolean;
  keepAwake: boolean;
  openLinksInBrowser: boolean;
}
export type PermissionStatus = "granted" | "denied" | "restricted" | "not-determined" | "unknown";
export type Permission = "accessibility" | "screen";
export interface SystemState {
  version: string;
  platform: string;
  mode: "new" | "existing";
  preferences: SystemPreferences;
  startupSupported: boolean;
  awakeRoutines: number;
  storage: { path: string | null; canMove: boolean; progress: string | null };
  permissions: Record<Permission, PermissionStatus> | null;
  shortcutError: boolean;
  menuBarError?: boolean;
  shortcutOptions: Record<ShortcutAction, readonly Shortcut[]>;
}
export interface SystemBridge {
  onShortcut?(listener: (action: "voice" | "dictation") => void): () => void;
  quickBot?(identity: { userId: string; spaceId: string }, botId?: string): Promise<string | null>;
  closeQuick?(): Promise<void>;
  openMain?(): Promise<void>;
  state(): Promise<SystemState>;
  set<K extends keyof SystemPreferences>(key: K, value: SystemPreferences[K]): Promise<SystemState>;
  moveStorage(recommended: boolean): Promise<SystemState>;
  openPermission(permission: Permission): Promise<void>;
}
