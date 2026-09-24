import { desktopBridge, windowChromeKind } from "../lib/desktop";

export function WindowChrome() {
  // Reserve space only for macOS's native inset traffic lights. Windows and Linux
  // own their controls in the system frame; duplicating them inside the app is misleading.
  if (windowChromeKind(desktopBridge()) !== "darwin") return null;
  return <div className="app-drag h-3 w-[72px]" aria-hidden="true" />;
}
