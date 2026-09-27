import { mkdirSync } from "node:fs";
import path from "node:path";

type PathApp = {
  getPath(name: "appData"): string;
  setName(name: string): void;
  setPath(name: "userData" | "sessionData", value: string): void;
};

/** Preserve the internal identity that Safe Storage and default OS paths use. */
export function configureDesktopUserData(app: PathApp, override?: string): void {
  // productName and bundle metadata remain "Ardur" for every visible surface.
  // Electron derives the macOS keychain service/account and Linux crypto name
  // from this internal name, so changing it would orphan encrypted settings.
  app.setName("Ardur Bot");
  const userData = override || path.join(app.getPath("appData"), "Ardur Bot");
  // Normal installs used the userData root for Chromium storage before rename.
  // Explicit data-directory overrides have always used a session subdirectory.
  const sessionData = override ? path.join(userData, "session") : userData;
  mkdirSync(sessionData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
}
