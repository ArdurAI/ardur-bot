import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { provisionReplayPostgres } from "./postgres.js";

const start = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), spawn: vi.fn() }));
vi.mock("@testcontainers/postgresql", () => ({
  PostgreSqlContainer: class {
    withDatabase() {
      return this;
    }
    start = start;
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

it.each(["explicit", "context"])(
  "accepts a local Windows pipe from the %s endpoint",
  async (source) => {
    const endpoint = "npipe:////./pipe/docker_engine";
    vi.stubEnv("DOCKER_HOST", source === "explicit" ? endpoint : undefined);
    vi.mocked(execFileSync).mockReturnValue(`${endpoint}\n`);
    // Stop at the provisioning boundary without contacting any Docker engine.
    const accepted = new Error("local endpoint accepted");
    start.mockRejectedValue(accepted);
    await expect(provisionReplayPostgres()).rejects.toBe(accepted);
    expect(start).toHaveBeenCalledOnce();
    expect(process.env.DOCKER_HOST).toBe(endpoint);
  },
);

it("preserves local Unix socket support", async () => {
  vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
  const accepted = new Error("local endpoint accepted");
  start.mockRejectedValue(accepted);
  await expect(provisionReplayPostgres()).rejects.toBe(accepted);
  expect(start).toHaveBeenCalledOnce();
});

it.each([
  "tcp://remote.invalid:2375",
  "tcp://127.0.0.1:2375",
  "ssh://remote.invalid",
  "npipe:////remote.invalid/pipe/docker_engine",
  "npipe://remote.invalid/pipe/docker_engine",
  "npipe:////./pipe/",
  "npipe:////./pipe/../remote",
])(
  "rejects unsafe endpoint %s before provisioning, explicitly and through context",
  async (endpoint) => {
    for (const source of ["explicit", "context"]) {
      vi.stubEnv("DOCKER_HOST", source === "explicit" ? endpoint : undefined);
      vi.mocked(execFileSync).mockReturnValue(`${endpoint}\n`);
      await expect(provisionReplayPostgres()).rejects.toThrow(/local/);
    }
    expect(start).not.toHaveBeenCalled();
  },
);
