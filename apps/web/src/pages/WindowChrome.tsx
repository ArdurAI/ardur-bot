import { desktopBridge, windowChromeKind } from "../lib/desktop";
import { TopNav } from "./shell/TopNav";

export function WindowChrome({ navigation = false }: { navigation?: boolean }) {
  // Reserve space only for macOS's native inset traffic lights. Windows and Linux
  // own their controls in the system frame; duplicating them inside the app is misleading.
  const mac = windowChromeKind(desktopBridge()) === "darwin";
  return (
    <div className="app-drag flex shrink-0 items-center gap-2">
      {mac ? <div className="h-3 w-[72px] shrink-0" aria-hidden="true" /> : null}
      {navigation ? <TopNav /> : null}
    </div>
  );
}
