import { app } from "electron";

/** Call once after app readiness, before creating any windows. */
export function enableDesktopAccessibility(): void {
  if (process.env.ARDUR_DESKTOP_ACCESSIBILITY !== "1") return;
  app.accessibilitySupportEnabled = true;
  console.info("Accessibility tree forced on for automation.");
}
