import { installSmokeProgress } from "./startup.js";

// Load only after the smoke watchdog and crash reporting are installed.
try {
  await import("./main.js");
} catch (error) {
  if (installSmokeProgress) installSmokeProgress.fail(error);
  else throw error;
}
