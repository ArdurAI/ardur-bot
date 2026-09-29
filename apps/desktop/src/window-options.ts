import type { DesktopBootSnapshot } from "@ardurbot/contracts";
import {
  LIGHT_WINDOW_BACKGROUND_COLOR,
  WINDOW_BACKGROUND_COLOR,
} from "./window-colors.generated.js";

export const DEFAULT_WARM_WINDOW_TTL_MS = 15 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function warmWindowTtlMs(value: string | undefined) {
  if (value === undefined || value.trim() === "") return DEFAULT_WARM_WINDOW_TTL_MS;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_TIMER_DELAY_MS
    ? parsed
    : DEFAULT_WARM_WINDOW_TTL_MS;
}

/**
 * The main window's colour until its page paints: the saved theme, or the system's when nothing
 * is saved, so a window shown before the first frame is already the right colour.
 */
export function windowBackgroundColor(
  snapshot: Pick<DesktopBootSnapshot, "theme"> | undefined,
  systemDark: boolean,
) {
  const theme = snapshot?.theme ?? "system";
  const light = theme === "system" ? !systemDark : theme === "light";
  return light ? LIGHT_WINDOW_BACKGROUND_COLOR : WINDOW_BACKGROUND_COLOR;
}

function windowChrome(platform: NodeJS.Platform) {
  const mac = platform === "darwin";
  return {
    backgroundColor: WINDOW_BACKGROUND_COLOR,
    autoHideMenuBar: true,
    frame: true,
    titleBarStyle: mac ? ("hiddenInset" as const) : ("default" as const),
    trafficLightPosition: mac ? { x: 16, y: 16 } : undefined,
  };
}

export function browserWindowOptions(platform: NodeJS.Platform) {
  // Hidden until ready-to-show so a cold start does not flash an empty frame.
  return { width: 1440, height: 900, ...windowChrome(platform), show: false };
}

/**
 * Unpackaged (dev) launches set the dock/taskbar icon by hand. macOS draws the file as-is,
 * so it needs the squircle-with-margins asset; packaged builds already use icon.icns.
 */
export function developmentIconFile(platform: NodeJS.Platform) {
  return platform === "darwin" ? "icon-macos.png" : "icon.png";
}

/** The first-run setup window is smaller and keeps the same platform chrome. */
export function setupWindowOptions(platform: NodeJS.Platform) {
  return {
    width: 720,
    height: 700,
    minWidth: 480,
    minHeight: 560,
    ...windowChrome(platform),
    show: true,
  };
}
