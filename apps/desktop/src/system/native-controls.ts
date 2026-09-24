import type { App, PowerSaveBlocker, SystemPreferences } from "electron";
import type { Permission, PermissionStatus } from "./contract.js";

export function startupSupported(platform: string): boolean {
  return platform === "darwin" || platform === "win32";
}

export function startupEnabled(platform: string, app: Pick<App, "getLoginItemSettings">): boolean {
  if (!startupSupported(platform)) return false;
  const state = app.getLoginItemSettings();
  return platform === "win32"
    ? state.openAtLogin && state.executableWillLaunchAtLogin
    : state.openAtLogin;
}

export function setStartup(
  platform: string,
  app: Pick<App, "setLoginItemSettings" | "getLoginItemSettings">,
  enabled: boolean,
): void {
  if (!startupSupported(platform))
    throw new Error("Run on startup is unavailable on this computer.");
  const previous = startupEnabled(platform, app);
  app.setLoginItemSettings({ openAtLogin: enabled, ...(platform === "win32" ? { enabled } : {}) });
  if (startupEnabled(platform, app) !== enabled) {
    app.setLoginItemSettings({
      openAtLogin: previous,
      ...(platform === "win32" ? { enabled: previous } : {}),
    });
    throw new Error("Allow startup in your system settings, then try again.");
  }
}

export function permissionStatus(value: string): PermissionStatus {
  return value === "granted" ||
    value === "denied" ||
    value === "restricted" ||
    value === "not-determined"
    ? value
    : "unknown";
}

export function permissions(
  platform: string,
  preferences: Pick<SystemPreferences, "isTrustedAccessibilityClient" | "getMediaAccessStatus">,
): Record<Permission, PermissionStatus> | null {
  if (platform !== "darwin") return null;
  return {
    accessibility: preferences.isTrustedAccessibilityClient(false) ? "granted" : "denied",
    screen: permissionStatus(preferences.getMediaAccessStatus("screen")),
  };
}

export function permissionUrl(permission: unknown): string {
  if (permission === "accessibility")
    return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
  if (permission === "screen")
    return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
  throw new Error("Choose an available permission.");
}

/** The main process owns this blocker, including when every renderer is closed. */
export class RoutinePower {
  private id: number | null = null;
  private count = 0;
  constructor(private readonly blocker: Pick<PowerSaveBlocker, "start" | "stop">) {}

  update(enabled: boolean, routines: number): void {
    const count = Number.isSafeInteger(routines) && routines > 0 ? routines : 0;
    if (enabled && count > 0) {
      if (this.id === null) this.id = this.blocker.start("prevent-app-suspension");
      this.count = count;
    } else this.stop();
  }

  get activeRoutines(): number {
    return this.count;
  }

  stop(): void {
    if (this.id !== null) this.blocker.stop(this.id);
    this.id = null;
    this.count = 0;
  }
}
