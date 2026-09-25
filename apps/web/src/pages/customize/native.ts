import { desktopBridge } from "../../lib/desktop";

export async function ensureCustomizationHost() {
  const desktop = desktopBridge();
  if (!desktop?.customization) throw new Error("Open the desktop app to manage local servers.");
  if ((await desktop.customization.info()).packaged && !(await desktop.host?.state())?.configured) {
    if (!desktop.host) throw new Error("Connect this computer first.");
    await desktop.host.setup();
  }
  return desktop.customization;
}
