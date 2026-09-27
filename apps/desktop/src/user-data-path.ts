import { mkdirSync } from "node:fs";
import path from "node:path";

type PathApp = {
  getPath(name: "appData"): string;
  setPath(name: "userData" | "sessionData", value: string): void;
};

/** Preserve the data folder used by releases before the display name changed. */
export function configureDesktopUserData(app: PathApp, override?: string): void {
  const userData = override || path.join(app.getPath("appData"), "Ardur Bot");
  const sessionData = path.join(userData, "session");
  mkdirSync(sessionData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", sessionData);
}
