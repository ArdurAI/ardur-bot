import { spawnSync } from "node:child_process";
import { COMPUTER_PROFILES } from "../packages/contracts/src/computer-profiles.js";

const engine = process.argv.includes("--podman") ? "podman" : "docker";
for (const profile of Object.values(COMPUTER_PROFILES)) {
  const result = spawnSync(
    engine,
    [
      "build",
      "--build-arg",
      `IMAGE_PROFILE=${profile.id}`,
      "-t",
      profile.tag,
      ...(profile.id === "base" ? ["-t", "ardurbot/computer:local"] : []),
      "infra/sandboxes/computer",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
