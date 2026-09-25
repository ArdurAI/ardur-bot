import net from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { containerCreateOptions, resolveComputerControlEndpoint } from "./computer-spec.js";
import { SCREEN_RELAY_SCRIPT, screenRelay } from "./screen-relay.js";
import { attemptComputerControl, shouldReplayComputerActions } from "./supervisor-logic.js";

describe("network-free Docker control", () => {
  it("uses none without port publication while keeping the existing exec fallback", async () => {
    const spec = containerCreateOptions({
      name: "computer",
      image: "fixture",
      botId: "bot",
      spaceId: "space",
      homePath: "/fixture",
      networkMode: "none",
      publishControlPort: true,
    });
    expect(spec.HostConfig.NetworkMode).toBe("none");
    expect(spec.HostConfig.PortBindings).toEqual({});
    expect(spec.ExposedPorts).toEqual({});
    const endpoint = resolveComputerControlEndpoint({
      token: "fixture",
      networkMode: "none",
      networks: { none: { IPAddress: "" } },
    });
    expect(endpoint).toBeUndefined();
    expect(shouldReplayComputerActions(await attemptComputerControl(undefined))).toBe(true);
  });
  it("tunnels bytes through Docker exec to only a local screen port", async () => {
    const stream = new PassThrough();
    const exec = vi.fn(async () => ({ start: vi.fn(async () => stream) }));
    const demuxStream = vi.fn((_stream, output) => {
      output.write("screen-bytes");
    });
    const container = { id: "fixture-relay", exec, modem: { demuxStream } };
    await expect(screenRelay(container as never, 22, "127.0.0.1")).rejects.toThrow(
      "Invalid screen port",
    );
    const [port, duplicate] = await Promise.all([
      screenRelay(container as never, 6080, "127.0.0.1"),
      screenRelay(container as never, 6080, "127.0.0.1"),
    ]);
    expect(duplicate).toBe(port);
    const socket = net.connect(port, "127.0.0.1");
    const data = await new Promise<string>((resolve, reject) => {
      socket.once("data", (bytes) => resolve(bytes.toString()));
      socket.once("error", reject);
    });
    expect(data).toBe("screen-bytes");
    expect(exec).toHaveBeenCalledWith({
      Cmd: ["python3", "-u", "-c", SCREEN_RELAY_SCRIPT, "6080"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });
    expect(SCREEN_RELAY_SCRIPT).toContain("('127.0.0.1', int(sys.argv[1]))");
    socket.destroy();
    stream.destroy();
  });
});
