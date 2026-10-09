import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { COMPUTER_PROFILES } from "../packages/contracts/src/computer-profiles.js";

// #199: Inspect build arguments without invoking Docker or changing local defaults.
vi.mock("node:child_process", () => ({ spawnSync: vi.fn(() => ({ status: 0 })) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

it.each([undefined, "mirror.gcr.io/library/"])(
  "passes a registry prefix only when supplied (%s)",
  async (prefix) => {
    vi.stubEnv("DOCKERHUB_LIBRARY_PREFIX", prefix);
    vi.resetModules();
    await import("./build-computers.js");
    expect(spawnSync).toHaveBeenCalledTimes(Object.keys(COMPUTER_PROFILES).length);
    for (const [index, profile] of Object.values(COMPUTER_PROFILES).entries()) {
      expect(vi.mocked(spawnSync).mock.calls[index]?.[1]).toEqual([
        "build",
        "--build-arg",
        `IMAGE_PROFILE=${profile.id}`,
        ...(prefix ? ["--build-arg", `DOCKERHUB_LIBRARY_PREFIX=${prefix}`] : []),
        "-t",
        profile.tag,
        ...(profile.id === "base" ? ["-t", "ardurbot/computer:local"] : []),
        "infra/sandboxes/computer",
      ]);
    }
  },
);
