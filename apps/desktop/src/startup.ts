import { app } from "electron";
import { installSmokeEnabled, startInstallSmokeWatchdog } from "./install-smoke.js";

export const installSmokeProgress = installSmokeEnabled(process.env)
  ? startInstallSmokeWatchdog({
      report: (message) => console.error(message),
      exit: (code) => app.exit(code),
    })
  : null;

if (installSmokeProgress) {
  if (!process.env.ARDURBOT_USER_DATA_DIR) {
    installSmokeProgress.fail("An isolated user-data directory is required.");
  }
  app.on("child-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") {
      installSmokeProgress.fail(`Child process stopped (${details.reason}).`);
    }
  });
  app.on("render-process-gone", () => installSmokeProgress.fail("Renderer crashed."));
  process.once("exit", () => installSmokeProgress.dispose());
}
