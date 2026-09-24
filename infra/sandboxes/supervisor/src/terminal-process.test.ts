import { spawnSync } from "node:child_process";
import { PassThrough, Readable } from "node:stream";
import type Docker from "dockerode";
import { describe, expect, it, vi } from "vitest";
import {
  assertNoDockerTerminals,
  openDockerTerminal,
  TERMINAL_GUARDIAN,
} from "./terminal-process.js";

function docker(exitCode = 0) {
  const stream = new PassThrough();
  const resize = vi.fn(async () => {});
  const exec = {
    start: vi.fn(async () => stream),
    resize,
    inspect: vi.fn(async () => ({ Running: false, ExitCode: exitCode })),
  };
  const container = {
    exec: vi
      .fn()
      .mockResolvedValueOnce(exec)
      .mockResolvedValue({
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 0 }),
      }),
    stop: vi.fn(async () => {}),
  };
  return { exec, stream, container, value: container as unknown as Docker.Container };
}
describe("Docker PTY process", () => {
  it("creates a TTY in the selected container as its user with a clean environment and fixed shell", async () => {
    const f = docker();
    const terminal = await openDockerTerminal(
      f.value,
      "1000:1000",
      "/home/ardurbot",
      "test-session",
      80,
      24,
      Date.now() + 60_000,
    );
    expect(f.container.exec).toHaveBeenCalledWith(
      expect.objectContaining({
        Tty: true,
        User: "1000:1000",
        WorkingDir: "/home/ardurbot",
        AttachStdin: true,
        Cmd: expect.arrayContaining(["/usr/bin/env", "-i", "/usr/bin/python3", TERMINAL_GUARDIAN]),
      }),
    );
    expect(f.exec.start).toHaveBeenCalledWith({ hijack: true, stdin: true, Tty: true });
    await terminal.resize(100, 30);
    expect(f.exec.resize).toHaveBeenLastCalledWith({ w: 100, h: 30 });
    await terminal.close();
    expect(f.stream.destroyed).toBe(true);
    expect(f.container.stop).not.toHaveBeenCalled();
    expect(f.container.exec.mock.calls[1]![0].Cmd.join(" ")).toContain("SIGTERM");
  });
  it("stops the computer if the descendant guardian dies without confirming cleanup", async () => {
    const f = docker(137);
    const terminal = await openDockerTerminal(
      f.value,
      "1000",
      "/home/ardurbot",
      "test-session",
      80,
      24,
      Date.now() + 60_000,
    );
    await terminal.close();
    expect(f.container.stop).toHaveBeenCalledWith({ t: 0 });
  });
  it("refuses orphan guardians after supervisor restart and waits for stop during revocation", async () => {
    const stop = vi.fn(async () => {});
    const container = {
      exec: async () => ({
        start: async () => Readable.from([]),
        inspect: async () => ({ ExitCode: 42 }),
      }),
      stop,
    } as unknown as Docker.Container;
    await expect(assertNoDockerTerminals(container)).rejects.toThrow("person");
    expect(stop).not.toHaveBeenCalled();
    await assertNoDockerTerminals(container, true);
    expect(stop).toHaveBeenCalled();
  });
});

it("keeps the in-container guardian valid Python", () => {
  const result = spawnSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], {
    input: TERMINAL_GUARDIAN,
  });
  expect(result.status).toBe(0);
});
