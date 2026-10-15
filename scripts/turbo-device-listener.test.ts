import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("passes explicit device listener settings through pnpm dev's environment filter", () => {
  const config = JSON.parse(readFileSync(new URL("../turbo.json", import.meta.url), "utf8"));
  const task = config.tasks["@ardurbot/api#dev"] ?? config.tasks.dev;
  expect(task.passThroughEnv).toEqual(
    expect.arrayContaining([
      "ARDURBOT_DEVICE_LISTENER_ENABLED",
      "ARDURBOT_DEVICE_LISTENER_BIND",
      "ARDURBOT_DEVICE_LISTENER_PORT",
      "ARDURBOT_DEVICE_LISTENER_ORIGIN",
    ]),
  );
});
