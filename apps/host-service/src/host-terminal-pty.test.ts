import type { HostTerminalProcess } from "@ardurbot/host-runtime/host-terminal";
import { TERMINAL_CLEANUP_DEADLINE_MS } from "@ardurbot/host-runtime/terminal-cleanup";
import type { IPty } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "./host-terminal-pty.js";
import { darwinHostTerminalFactory, loadDarwinPty } from "./host-terminal-pty.js";

const row = (pid: number, parent = 1, group = pid, birth = `birth-${pid}`): ProcessIdentity => ({
  pid,
  parent,
  group,
  birth,
  zombie: false,
});
let rows: ProcessIdentity[];
let processes: HostTerminalProcess[];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  rows = [row(100)];
  processes = [];
});
afterEach(async () => {
  rows = [];
  await Promise.all(processes.map((p) => p.killTree()));
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture() {
  let data: (data: string) => void = () => {};
  let exit: () => void = () => {};
  const dataDispose = vi.fn();
  const child = {
    pid: 100,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    onData: vi.fn((listener: typeof data) => {
      data = listener;
      return { dispose: dataDispose };
    }),
    onExit: vi.fn((listener: typeof exit) => {
      exit = listener;
      return { dispose: vi.fn() };
    }),
  };
  const spawn = vi.fn(() => child as unknown as IPty);
  const snapshot = vi.fn(async () => [...rows]);
  const signal = vi.fn();
  const factory = darwinHostTerminalFactory({ spawn }, { snapshot, signal });
  const guard = {
    paths: ["/fixture/protected"],
    ports: [12345],
    sockets: ["/fixture/engine.sock"],
  };
  const environment = { PATH: "/usr/bin:/bin", HOME: "/fixture", TERM: "xterm-256color" };
  const terminal = await factory(guard).spawn("/bin/sh", "/fixture/work", environment, 93, 31);
  processes.push(terminal);
  return {
    terminal,
    spawn,
    snapshot,
    signal,
    child,
    dataDispose,
    data: (value: string) => data(value),
    exit: () => exit(),
    environment,
  };
}

describe("macOS host PTY boundary", () => {
  it("launches the requested login shell under all guards with only the supplied environment", async () => {
    const f = await fixture();
    expect(f.spawn).toHaveBeenCalledOnce();
    const [binary, args, options] = f.spawn.mock.calls[0]! as unknown as [string, string[], object];
    expect(binary).toBe("/usr/bin/sandbox-exec");
    expect(args.slice(2)).toEqual(["/bin/sh", "-l"]);
    expect(args[0]).toBe("-p");
    expect(args[1]).toContain('(subpath "/fixture/protected")');
    expect(args[1]).toContain('(remote ip "localhost:12345")');
    expect(args[1]).toContain('(remote unix-socket (literal "/fixture/engine.sock"))');
    expect(options).toEqual({
      cwd: "/fixture/work",
      env: f.environment,
      cols: 93,
      rows: 31,
      name: "xterm-256color",
      encoding: null,
    });
  });

  it("forwards input, including split UTF-8, resize, binary output and subscription disposal", async () => {
    const f = await fixture();
    f.terminal.write(Uint8Array.of(0xe2));
    f.terminal.write(Uint8Array.of(0x82, 0xac, 3));
    expect(f.child.write.mock.calls).toEqual([
      [Buffer.from([0xe2])],
      [Buffer.from([0x82, 0xac, 3])],
    ]);
    f.terminal.resize(120, 40);
    expect(f.child.resize).toHaveBeenCalledWith(120, 40);
    const listener = vi.fn();
    expect(f.child.pause).toHaveBeenCalledOnce();
    expect(f.child.resume).not.toHaveBeenCalled();
    const dispose = f.terminal.onData(listener);
    expect(f.child.resume).toHaveBeenCalledOnce();
    f.data("hello");
    expect(listener).toHaveBeenCalledWith(Buffer.from("hello"));
    dispose();
    expect(f.dataDispose).toHaveBeenCalledOnce();
  });

  it("delivers exit to current and late listeners, and rejects writes after exit", async () => {
    const f = await fixture();
    const listener = vi.fn();
    const dispose = f.terminal.onExit(listener);
    dispose();
    f.exit();
    expect(listener).not.toHaveBeenCalled();
    f.terminal.onExit(listener);
    expect(listener).toHaveBeenCalledOnce();
    expect(() => f.terminal.write(Uint8Array.of(1))).toThrow("closing");
  });

  it("signals the group before detached descendants and escalates TERM to KILL", async () => {
    const f = await fixture();
    rows.push(row(101, 100, 100), row(102, 101, 102), row(900));
    const cleanup = f.terminal.killTree();
    expect(f.terminal.killTree()).toBe(cleanup);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signal.mock.calls).toEqual([
      [-100, "SIGTERM"],
      [102, "SIGTERM"],
    ]);
    await vi.advanceTimersByTimeAsync(1500);
    const kills = f.signal.mock.calls.filter(([, signal]) => signal === "SIGKILL");
    expect(kills.slice(0, 2)).toEqual([
      [-100, "SIGKILL"],
      [102, "SIGKILL"],
    ]);
    expect(f.signal.mock.calls.some(([pid]) => pid === 900 || pid === -900)).toBe(false);
    rows = [row(900)];
    await vi.advanceTimersByTimeAsync(50);
    await cleanup;
  });

  it("remembers a detached descendant when the shell exits during cleanup", async () => {
    const f = await fixture();
    rows.push(row(101, 100, 101));
    await vi.advanceTimersByTimeAsync(50);
    rows = [row(101, 1, 101)];
    f.exit();
    const cleanup = f.terminal.killTree();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signal).toHaveBeenCalledExactlyOnceWith(101, "SIGTERM");
    rows = [];
    await vi.advanceTimersByTimeAsync(50);
    await cleanup;
  });

  it("never signals a reused PID or adopts its children", async () => {
    const f = await fixture();
    rows = [row(100, 1, 100, "new-process"), row(101, 100, 100)];
    await f.terminal.killTree();
    expect(f.signal).not.toHaveBeenCalled();
  });

  it("never adopts a reused shell PID after the original exited before the first lookup", async () => {
    rows = [];
    const f = await fixture();
    rows = [row(100, 1, 100, "new-process"), row(101, 100, 100)];
    await f.terminal.killTree();
    expect(f.signal).not.toHaveBeenCalled();
  });

  it("refuses a group signal if even one group member is outside the spawned tree", async () => {
    const f = await fixture();
    rows.push(row(101, 100, 100), row(900, 1, 100));
    const cleanup = f.terminal.killTree();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signal.mock.calls).toEqual([
      [100, "SIGTERM"],
      [101, "SIGTERM"],
    ]);
    rows = [row(900, 1, 100)];
    await vi.advanceTimersByTimeAsync(50);
    await cleanup;
  });

  it("rejects before the provider deadline when the tree survives KILL and permits cleanup retry", async () => {
    const f = await fixture();
    const cleanup = f.terminal.killTree();
    const rejected = expect(cleanup).rejects.toThrow("still closing");
    await vi.advanceTimersByTimeAsync(TERMINAL_CLEANUP_DEADLINE_MS - 500);
    await rejected;
    expect(Date.now()).toBeLessThan(TERMINAL_CLEANUP_DEADLINE_MS);
    expect(f.signal).toHaveBeenCalledWith(-100, "SIGKILL");
    expect(() => f.terminal.resize(80, 24)).toThrow("closing");
    rows = [];
    await f.terminal.killTree();
  });

  it("does not equate a failed lookup with a dead tree", async () => {
    const f = await fixture();
    f.snapshot.mockRejectedValueOnce(new Error("lookup failed"));
    await expect(f.terminal.killTree()).rejects.toThrow("lookup failed");
    expect(f.signal).not.toHaveBeenCalled();
  });

  it("bounds an unresponsive process lookup instead of waiting past the cleanup deadline", async () => {
    const f = await fixture();
    f.snapshot.mockReturnValueOnce(new Promise(() => {}));
    const cleanup = f.terminal.killTree();
    const rejected = expect(cleanup).rejects.toThrow("lookup timed out");
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(f.signal).not.toHaveBeenCalled();
  });

  it("treats zombies as exited rather than signaling them repeatedly", async () => {
    const f = await fixture();
    rows[0]!.zombie = true;
    await f.terminal.killTree();
    expect(f.signal).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "darwin")("does not load the addon on other platforms", () => {
    expect(loadDarwinPty()).toBeUndefined();
  });
});
