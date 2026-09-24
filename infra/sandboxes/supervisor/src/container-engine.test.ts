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
  it("uses a configured generic socket and discovers macOS and Linux rootless sockets", () => {
    const inspect = vi.fn(() =>
      JSON.stringify([
        { State: "running", ConnectionInfo: { PodmanSocket: { Path: "/tmp/podman.sock" } } },
      ]),
    );
    expect(
      discoverEngineSocket(
        { CONTAINER_HOST: "unix:///tmp/selected.sock" },
        "darwin",
        () => false,
        inspect,
      ),
    ).toBe("/tmp/selected.sock");
    expect(inspect).not.toHaveBeenCalled();
    expect(discoverEngineSocket({}, "darwin", (file) => file === "/tmp/podman.sock", inspect)).toBe(
      "/tmp/podman.sock",
    );
    expect(
      discoverEngineSocket(
        { XDG_RUNTIME_DIR: "/run/user/1234" },
        "linux",
        (file) => file === "/run/user/1234/podman/podman.sock",
      ),
    ).toBe("/run/user/1234/podman/podman.sock");
    expect(() => socketPath("tcp://example.test:2375")).toThrow("Unix engine socket");
    expect(discoverEngineSocket({}, "win32", () => false)).toBe("//./pipe/docker_engine");
  });
});
