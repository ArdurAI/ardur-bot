import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const composeAvailable =
  spawnSync("docker", ["compose", "version"], { timeout: 10_000 }).status === 0;
describe.runIf(composeAvailable)("Compose import callback routing", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "import-compose-"));
    writeFileSync(path.join(root, "empty.env"), "");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  it.each([
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "docker-compose.topology.yml",
    "docker-compose.images.yml",
  ])("resolves %s workers to the API service instead of their own loopback", (file) => {
    const config = JSON.parse(
      execFileSync(
        "docker",
        [
          "compose",
          "--env-file",
          path.join(root, "empty.env"),
          "-f",
          path.resolve(import.meta.dirname, "../../../infra/compose", file),
          "config",
          "--format",
          "json",
          "--no-env-resolution",
          "--no-interpolate",
        ],
        { encoding: "utf8" },
      ),
    );
    expect(config.services.api).toBeDefined();
    expect(config.services.worker.environment.API_INTERNAL_URL).toBe("http://api:3100");
  });
});
