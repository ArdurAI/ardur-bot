import { describe, expect, it, vi } from "vitest";
import { containerCreateOptions } from "./computer-spec.js";
import {
  discoverEngineSocket,
  engineFromResponses,
  engineHostConfig,
  engineUser,
  socketPath,
} from "./container-engine.js";

describe("Podman compatibility", () => {
  it("prefers a reachable active Docker context over a stale conventional socket", async () => {
    const probe = vi.fn(async (socket: string) => socket === "/tmp/active-engine.sock");
    const context = () =>
      JSON.stringify([{ Endpoints: { docker: { Host: "unix:///tmp/active-engine.sock" } } }]);
    expect(await discoverEngineSocket({}, "darwin", probe, () => "[]", context)).toBe(
      "/tmp/active-engine.sock",
    );
    expect(probe).toHaveBeenCalledWith("/tmp/active-engine.sock");
  });
  it("detects Docker-compatible Podman version and rootless info responses", () => {
    const podman = engineFromResponses(
      { Components: [{ Name: "Podman Engine", Version: "5.8.0" }] },
      { SecurityOptions: ["name=rootless", "name=seccomp,profile=default"] },
    );
    expect(podman).toEqual({ name: "podman", rootless: true });
    expect(engineUser(podman, "501:20")).toBe("1000:1000");
    const options = containerCreateOptions({
      name: "computer",
      botId: "b",
      spaceId: "s",
      homePath: "/tmp/home",
      image: "ardurbot/computer:0.1.0-developer",
      user: engineUser(podman, "501:20"),
      engine: podman,
    });
    expect(options.HostConfig.UsernsMode).toBe("keep-id:uid=1000,gid=1000");
    expect(options.HostConfig.Binds).toEqual(["/tmp/home:/home/ardurbot"]);
    expect(options.User).toBe("1000:1000");
    expect(options.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(engineHostConfig({ name: "docker", rootless: false })).toEqual({});
  });
  it("uses a configured generic socket and discovers macOS and Linux rootless sockets", async () => {
    const inspect = vi.fn(() =>
      JSON.stringify([
        { State: "running", ConnectionInfo: { PodmanSocket: { Path: "/tmp/podman.sock" } } },
      ]),
    );
    expect(
      await discoverEngineSocket(
        { CONTAINER_HOST: "unix:///tmp/selected.sock" },
        "darwin",
        () => false,
        inspect,
        () => "[]",
      ),
    ).toBe("/tmp/selected.sock");
    expect(inspect).not.toHaveBeenCalled();
    expect(
      await discoverEngineSocket(
        {},
        "darwin",
        (file) => file === "/tmp/podman.sock",
        inspect,
        () => "[]",
      ),
    ).toBe("/tmp/podman.sock");
    expect(
      await discoverEngineSocket(
        { XDG_RUNTIME_DIR: "/run/user/1234" },
        "linux",
        (file) => file === "/run/user/1234/podman/podman.sock",
        () => "[]",
        () => "[]",
      ),
    ).toBe("/run/user/1234/podman/podman.sock");
    expect(() => socketPath("tcp://example.test:2375")).toThrow("Unix engine socket");
    expect(await discoverEngineSocket({}, "win32", () => false)).toBe("//./pipe/docker_engine");
  });
});

it("rejects stale and remote context endpoints, and never substitutes an explicit socket", async () => {
  const probe = vi.fn(async (socket: string) => socket === "/var/run/docker.sock");
  const inspect = vi.fn(() =>
    JSON.stringify([{ Endpoints: { docker: { Host: "unix:///tmp/stale.sock" } } }]),
  );
  expect(await discoverEngineSocket({}, "linux", probe, () => "[]", inspect)).toBe(
    "/var/run/docker.sock",
  );
  expect(probe.mock.calls.map(([socket]) => socket)).toEqual([
    "/tmp/stale.sock",
    "/var/run/docker.sock",
  ]);
  probe.mockClear();
  inspect.mockClear();
  expect(
    await discoverEngineSocket(
      { DOCKER_SOCKET: "/tmp/explicit.sock" },
      "linux",
      probe,
      () => "[]",
      inspect,
    ),
  ).toBe("/tmp/explicit.sock");
  expect(inspect).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  expect(
    await discoverEngineSocket(
      {},
      "linux",
      probe,
      () => "[]",
      () => JSON.stringify([{ Endpoints: { docker: { Host: "ssh://engine.example.test" } } }]),
    ),
  ).toBe("/var/run/docker.sock");
});
