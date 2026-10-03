import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("passes detailed process logging beside the Hermes selector to API and worker dev tasks", () => {
  const config = JSON.parse(
    readFileSync(fileURLToPath(new URL("../turbo.json", import.meta.url)), "utf8"),
  );
  for (const name of ["@ardurbot/api", "@ardurbot/worker"]) {
    const task = config.tasks[`${name}#dev`] ?? config.tasks.dev;
    expect(task.passThroughEnv).toContain("ARDUR_HERMES_INSTALL");
    expect(task.passThroughEnv).toContain("ARDUR_DETAILED_PROCESS_LOGS");
  }
});
