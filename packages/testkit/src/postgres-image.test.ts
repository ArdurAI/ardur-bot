import { afterEach, expect, it, vi } from "vitest";

// #199: Verify image selection and cache gates without contacting Docker or Postgres.
const { inspect, construct, start } = vi.hoisted(() => ({
  inspect: vi.fn(),
  construct: vi.fn(),
  start: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync: inspect, spawn: vi.fn() }));
vi.mock("@testcontainers/postgresql", () => ({
  PostgreSqlContainer: class {
    constructor(image: string) {
      construct(image);
    }
    withDatabase() {
      return this;
    }
    start = start;
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.resetModules();
});

it.each([undefined, "mirror.gcr.io/library/postgres:16-alpine"])(
  "provisions the selected Postgres image (%s)",
  async (override) => {
    vi.stubEnv("ARDUR_TEST_POSTGRES_IMAGE", override);
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
    vi.resetModules();
    const selected = override ?? "postgres:16-alpine";
    const { TEST_POSTGRES_IMAGE } = await import("@ardurbot/testkit/postgres-image");
    expect(TEST_POSTGRES_IMAGE).toBe(selected);
    const { provisionReplayPostgres } = await import("./scoreboard/replay/postgres.js");
    const stopped = new Error("stopped before Docker provisioning");
    start.mockRejectedValue(stopped);
    await expect(provisionReplayPostgres()).rejects.toBe(stopped);
    expect(construct).toHaveBeenCalledExactlyOnceWith(selected);
    expect(inspect).not.toHaveBeenCalled();
  },
);

it.each([undefined, "false", "true"])(
  "requires Ryuk only when the reaper is enabled (%s)",
  async (disabled) => {
    const postgres = "mirror.gcr.io/library/postgres:16-alpine";
    vi.stubEnv("ARDUR_TEST_POSTGRES_IMAGE", postgres);
    vi.stubEnv("TESTCONTAINERS_RYUK_DISABLED", disabled);
    vi.resetModules();
    inspect.mockReturnValue(JSON.stringify({ Id: "sha256:fixture", Size: 42 }));
    const { requireCachedMatrixImages } = await import("./scoreboard/experiments/evidence.js");
    const tags = disabled === "true" ? [postgres] : [postgres, "testcontainers/ryuk:0.14.0"];
    expect(requireCachedMatrixImages().map((image) => image.tag)).toEqual(tags);
    expect(inspect.mock.calls.map((call) => call[1][2])).toEqual(tags);
  },
);

it("preserves CI image and reaper settings without preserving credentials", async () => {
  const { credentialFreeEnvironment } = await import("./scoreboard/replay/offline.js");
  expect(
    credentialFreeEnvironment({
      ARDUR_TEST_POSTGRES_IMAGE: "mirror.gcr.io/library/postgres:16-alpine",
      TESTCONTAINERS_RYUK_DISABLED: "true",
      DATABASE_URL: "untrusted",
      OPENAI_API_KEY: "synthetic",
    }),
  ).toEqual({
    ARDUR_TEST_POSTGRES_IMAGE: "mirror.gcr.io/library/postgres:16-alpine",
    TESTCONTAINERS_RYUK_DISABLED: "true",
  });
});
