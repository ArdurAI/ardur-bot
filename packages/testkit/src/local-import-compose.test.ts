import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const composeAvailable =
  spawnSync("docker", ["compose", "version"], { timeout: 10_000 }).status === 0;
if (process.env.CI && !composeAvailable)
  throw new Error("Docker Compose is required in CI to verify worker callback routing.");
// Rendering needs the Compose CLI, but no running Docker daemon.
describe.runIf(composeAvailable)("Compose routing (requires Docker Compose CLI)", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), "import-compose-"));
    mkdirSync(path.join(root, "infra/compose"), { recursive: true });
    const env = [
      "POSTGRES_PASSWORD=offline-compose-password",
      "SCREEN_PROXY_SECRET=offline-compose-screen-secret",
      "SANDBOX_SUPERVISOR_TOKEN=offline-compose-supervisor-token",
      "HTTP_PROXY=http://proxy.example.test:3128",
      "HTTPS_PROXY=http://proxy.example.test:3128",
      "NO_PROXY=api,postgres,localhost",
    ].join("\n");
    // Compose v2 also checks service env_file paths during config rendering.
    // Recreate the layout with synthetic values, never a developer's .env.
    writeFileSync(path.join(root, ".env"), env);
    writeFileSync(path.join(root, "infra/compose/.env"), env);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  it.each([
    "docker-compose.yml",
    "docker-compose.prod.yml",
    "docker-compose.topology.yml",
    "docker-compose.images.yml",
  ])("resolves %s workers to the API service instead of their own loopback", (file) => {
    const fixture = path.join(root, "infra/compose", file);
    copyFileSync(path.resolve(import.meta.dirname, "../../../infra/compose", file), fixture);
    const config = JSON.parse(
      execFileSync(
        "docker",
        [
          "compose",
          "--env-file",
          path.join(root, ".env"),
          "-f",
          fixture,
          "config",
          "--format",
          "json",
        ],
        // Resolve the same configuration Docker runs, without reading owner env
        // files or inheriting shell credentials, deployment paths or proxies.
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            APPDATA: process.env.APPDATA,
            DOCKER_CONFIG: process.env.DOCKER_CONFIG,
          },
        },
      ),
    );
    expect(config.services.api).toBeDefined();
    expect(config.services.worker.environment.API_INTERNAL_URL).toBe("http://api:3100");
    expect(config.services.worker.environment.HTTP_PROXY).toBe("http://proxy.example.test:3128");
    for (const key of [
      "DATABASE_URL",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]) {
      expect(config.services.api.environment[key]).toBeDefined();
      expect(config.services.worker.environment[key]).toBe(config.services.api.environment[key]);
    }
  });
});
