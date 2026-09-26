import type { StorageBridge } from "../../../../desktop/src/storage-report";
import { desktopBridge } from "../../lib/desktop";

export type { DesktopStorageRow, StorageBridge } from "../../../../desktop/src/storage-report";

/** Optional so an older desktop shell never renders controls it cannot enforce. */
export function storageBridge(): StorageBridge | undefined {
  const desktop = desktopBridge();
  if (!desktop || !("storage" in desktop)) return undefined;
  return desktop.storage as StorageBridge | undefined;
}
