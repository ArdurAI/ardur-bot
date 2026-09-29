import type { DesktopBootSnapshot } from "@ardurbot/contracts";
import { desktopBridge } from "./desktop";

let known: Partial<DesktopBootSnapshot> = {};
let sent: DesktopBootSnapshot | null = null;

/**
 * Tell the desktop app which theme and language this window shows, so its next window opens in
 * them. Waits until both are known, and sends again only when one of them changes.
 */
export function rememberDesktopBoot(values: Partial<DesktopBootSnapshot>): void {
  const save = desktopBridge()?.boot?.save;
  if (!save) return;
  known = { ...known, ...values };
  const { theme, language } = known;
  if (theme === undefined || language === undefined) return;
  if (sent?.theme === theme && sent.language === language) return;
  const snapshot = { theme, language };
  sent = snapshot;
  save(snapshot).catch(() => {
    // The next change tries again; until then the next window keeps the older colours.
    if (sent === snapshot) sent = null;
  });
}
