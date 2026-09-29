import type { DesktopBootSnapshot } from "@ardurbot/contracts";
import { desktopBridge } from "./desktop";

let sent: DesktopBootSnapshot | null = null;

/**
 * Tell the desktop app which theme this window shows, so its next window opens in
 * it. Sends again only when the theme changes.
 */
export function rememberDesktopBoot(values: Partial<DesktopBootSnapshot>): void {
  const save = desktopBridge()?.boot?.save;
  if (!save) return;
  const { theme } = values;
  if (theme === undefined) return;
  if (sent?.theme === theme) return;
  const snapshot = { theme };
  sent = snapshot;
  save(snapshot).catch(() => {
    // The next change tries again; until then the next window keeps the older colours.
    if (sent === snapshot) sent = null;
  });
}
