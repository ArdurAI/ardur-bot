import { app } from "electron";
import type { CommandLineLike } from "./cache-limits.js";

/**
 * Opt-in for automation and screen readers. Any other value leaves Chromium's
 * own screen-reader detection unchanged.
 */
export function desktopAccessibilityRequested(): boolean {
  return process.env.ARDUR_DESKTOP_ACCESSIBILITY === "1";
}

/**
 * Switches that exist in Electron 44.3.0 (Chromium 152.0.7977.78). Append
 * before `app.ready`; Chromium ignores them afterwards.
 *
 * `disable-backgrounding-occluded-windows` keeps an occluded window visible
 * (content/public/common/content_switches.cc, used by WebContentsImpl).
 * `disable-renderer-backgrounding` keeps a background renderer at foreground
 * process priority. It does not by itself stop timer or paint throttling.
 * `force-renderer-accessibility` builds the renderer tree at startup instead
 * of waiting for a screen reader (ui/accessibility/accessibility_switches.cc).
 * No bundle argument, so a later mode change is still allowed.
 *
 * `CalculateNativeWinOcclusion` is Windows-only and is not applied.
 */
export const DESKTOP_ACCESSIBILITY_SWITCHES = [
  "disable-backgrounding-occluded-windows",
  "disable-renderer-backgrounding",
  "force-renderer-accessibility",
] as const;

export const ACCESSIBILITY_FORCED_LOG = "Accessibility tree forced on for automation.";
export const ACCESSIBILITY_RESTORED_LOG = "Accessibility tree restored for automation.";

/** Call before `app.whenReady()`. */
export function applyDesktopAccessibilitySwitches(commandLine: CommandLineLike): void {
  if (!desktopAccessibilityRequested()) return;
  for (const name of DESKTOP_ACCESSIBILITY_SWITCHES) commandLine.appendSwitch(name);
}

/**
 * `webPreferences.backgroundThrottling` defaults to true and throttles a
 * backgrounded page. https://www.electronjs.org/docs/latest/api/structures/web-preferences
 */
export function desktopAccessibilityWebPreferences(): { backgroundThrottling?: false } {
  if (!desktopAccessibilityRequested()) return {};
  return { backgroundThrottling: false };
}

let restoring = false;

function reassertDesktopAccessibility(log: boolean): void {
  if (!desktopAccessibilityRequested() || restoring) return;
  const wasEnabled = app.accessibilitySupportEnabled;
  restoring = true;
  try {
    app.accessibilitySupportEnabled = true;
    if (log || !wasEnabled) console.info(ACCESSIBILITY_RESTORED_LOG);
  } finally {
    restoring = false;
  }
}

function watchRendererAccessibility(contents: Electron.WebContents): void {
  let url: string | null = null;
  contents.on("render-process-gone", () => {
    reassertDesktopAccessibility(true);
  });
  contents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame) return;
    const previous = url;
    url = details.url;
    // In-app route changes (pushState) only move the remembered URL, so a later
    // reload of the new route is still recognized.
    if (details.isSameDocument) return;
    // A same-URL main-frame navigation is a reload. A new document at a
    // different URL is not, and the startup switch already covers it.
    if (previous !== null && previous === details.url) reassertDesktopAccessibility(true);
  });
}

/** Call once after app readiness, before creating any windows. */
export function enableDesktopAccessibility(): void {
  if (!desktopAccessibilityRequested()) return;
  app.accessibilitySupportEnabled = true;
  console.info(ACCESSIBILITY_FORCED_LOG);
  // Assistive tech can turn support off again. darwin and win32 only.
  // https://www.electronjs.org/docs/latest/api/app#event-accessibility-support-changed-macos-windows
  app.on("accessibility-support-changed", (_event, enabled) => {
    if (enabled !== false) return;
    reassertDesktopAccessibility(true);
  });
  app.on("browser-window-created", (_event, browserWindow) => {
    browserWindow.webContents.backgroundThrottling = false;
    reassertDesktopAccessibility(false);
  });
  app.on("web-contents-created", (_event, contents) => {
    watchRendererAccessibility(contents);
  });
}
