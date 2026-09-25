import type { SystemBridge } from "../../../../desktop/src/system/bridge";
import { desktopBridge } from "../../lib/desktop";

export type {
  PermissionStatus,
  Shortcut,
  ShortcutAction,
  SystemBridge,
  SystemPreferences,
  SystemState,
} from "../../../../desktop/src/system/bridge";

/** Optional so an older desktop shell never renders controls it cannot enforce. */
export function systemBridge(): SystemBridge | undefined {
  const desktop = desktopBridge();
  if (!desktop || !("system" in desktop)) return undefined;
  return desktop.system as SystemBridge | undefined;
}
