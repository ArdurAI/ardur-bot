import type {
  App,
  GlobalShortcut,
  SystemPreferences as NativePreferences,
  PowerSaveBlocker,
} from "electron";
import type { Permission, ShortcutAction, SystemPreferences, SystemState } from "./contract.js";
import { DEFAULT_PREFERENCES, SHORTCUT_OPTIONS, validPreference } from "./contract.js";
import {
  permissions,
  permissionUrl,
  RoutinePower,
  setStartup,
  startupEnabled,
  startupSupported,
} from "./native-controls.js";
import { SystemShortcuts } from "./shortcuts.js";
import type { StorageMove } from "./storage.js";

export interface SystemDependencies {
  platform: string;
  app: Pick<App, "getVersion" | "getLoginItemSettings" | "setLoginItemSettings">;
  shortcuts: Pick<GlobalShortcut, "register" | "unregister">;
  power: Pick<PowerSaveBlocker, "start" | "stop">;
  permissions: Pick<NativePreferences, "isTrustedAccessibilityClient" | "getMediaAccessStatus">;
  store: { read(): Promise<SystemPreferences>; write(value: SystemPreferences): Promise<void> };
  mode(): "new" | "existing";
  dataFolder(): string | null;
  routines(): Promise<number>;
  shortcut(action: ShortcutAction): void;
  menuBar(enabled: boolean): void;
  openExternal(url: string): Promise<void>;
  storage?: StorageMove;
}

export class SystemController {
  private preferences = { ...DEFAULT_PREFERENCES };
  readonly shortcuts: SystemShortcuts;
  private readonly power: RoutinePower;
  private enabledRoutines = 0;
  private shortcutError = false;
  private menuBarError = false;
  private tail = Promise.resolve();
  private stopped = false;
  private refreshGeneration = 0;

  constructor(private readonly deps: SystemDependencies) {
    this.shortcuts = new SystemShortcuts(deps.shortcuts, deps.platform, deps.shortcut);
    this.power = new RoutinePower(deps.power);
  }

  async initialize(): Promise<void> {
    this.preferences = await this.deps.store.read();
    try {
      this.shortcuts.apply(this.preferences);
    } catch {
      this.shortcutError = true;
    }
    if (this.deps.platform === "darwin") {
      try {
        this.deps.menuBar(this.preferences.menuBar);
      } catch {
        this.preferences.menuBar = false;
        this.menuBarError = true;
      }
    }
    await this.refreshRoutines();
  }

  state(): SystemState {
    const mode = this.deps.mode();
    return {
      version: this.deps.app.getVersion(),
      platform: this.deps.platform,
      mode,
      preferences: {
        ...this.preferences,
        runOnStartup: startupEnabled(this.deps.platform, this.deps.app),
      },
      startupSupported: startupSupported(this.deps.platform),
      awakeRoutines: this.power.activeRoutines,
      storage: {
        path: mode === "new" ? this.deps.dataFolder() : null,
        canMove: mode === "new" && Boolean(this.deps.storage),
        progress: this.deps.storage?.progress ?? null,
      },
      permissions: permissions(this.deps.platform, this.deps.permissions),
      shortcutError: this.shortcutError,
      menuBarError: this.menuBarError,
      shortcutOptions: SHORTCUT_OPTIONS,
    };
  }

  set(key: unknown, value: unknown): Promise<SystemState> {
    const result = this.tail.then(async () => {
      if (this.stopped || !validPreference(key, value))
        throw new Error("Choose an available setting.");
      const previous = {
        ...this.preferences,
        runOnStartup: startupEnabled(this.deps.platform, this.deps.app),
      };
      const next = { ...previous, [key]: value };
      if (key === "menuBar" && this.deps.platform !== "darwin")
        throw new Error("Menu bar settings are unavailable on this computer.");
      if (key === "runOnStartup") setStartup(this.deps.platform, this.deps.app, next.runOnStartup);
      const binding = key === "quickAccess" || key === "voice" || key === "dictation";
      if (binding) this.shortcuts.apply(next);
      if (key === "menuBar") this.deps.menuBar(next.menuBar);
      try {
        await this.deps.store.write(next);
      } catch {
        if (this.stopped) throw new Error("Could not save this setting; try again.");
        if (key === "runOnStartup")
          setStartup(this.deps.platform, this.deps.app, previous.runOnStartup);
        if (binding) this.shortcuts.apply(previous);
        if (key === "menuBar") this.deps.menuBar(previous.menuBar);
        throw new Error("Could not save this setting; try again.");
      }
      this.preferences = next;
      if (this.stopped) return this.state();
      if (binding) this.shortcutError = false;
      if (key === "menuBar") this.menuBarError = false;
      if (key === "keepAwake" && next.keepAwake) await this.refreshRoutines();
      else this.power.update(next.keepAwake, this.enabledRoutines);
      return this.state();
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async refreshRoutines(): Promise<void> {
    const generation = ++this.refreshGeneration;
    const count = await this.deps.routines().catch(() => 0);
    if (this.stopped || generation !== this.refreshGeneration) return;
    this.enabledRoutines = count;
    this.power.update(this.preferences.keepAwake, count);
  }

  async moveStorage(recommended: unknown): Promise<SystemState> {
    if (
      this.stopped ||
      this.deps.mode() !== "new" ||
      !this.deps.storage ||
      typeof recommended !== "boolean"
    )
      throw new Error("This folder is managed by the server.");
    await this.deps.storage.move(recommended);
    return this.state();
  }

  async openPermission(permission: Permission): Promise<void> {
    if (this.deps.platform !== "darwin")
      throw new Error("This permission is unavailable on this computer.");
    await this.deps.openExternal(permissionUrl(permission));
  }

  get openLinksInBrowser(): boolean {
    return this.preferences.openLinksInBrowser;
  }

  dispose(): void {
    this.stopped = true;
    this.refreshGeneration += 1;
    try {
      this.shortcuts.dispose();
    } finally {
      this.power.stop();
    }
  }
}
