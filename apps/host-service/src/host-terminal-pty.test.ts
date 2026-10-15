import type { HostTerminalProcess } from "@ardurbot/host-runtime/host-terminal";
import { TERMINAL_CLEANUP_DEADLINE_MS } from "@ardurbot/host-runtime/terminal-cleanup";
import type { IPty } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProcessIdentity } from "./host-terminal-pty.js";
import { darwinHostTerminalFactory, loadDarwinPty } from "./host-terminal-pty.js";
import { linuxHostTerminalFactory } from "./host-terminal-pty-linux.js";

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
function fakeOperations() {
  return {
    snapshot: vi.fn(async (_timeoutMs: number) => [...rows]),
    signal: vi.fn(),
  };
}
function fakePty(pid = 100) {
  let data: (data: string) => void = () => {};
  let exit: () => void = () => {};
  const dataDispose = vi.fn();
  const child = {
    pid,
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
  return {
    spawn,
    child,
    dataDispose,
    data: (value: string) => data(value),
    exit: () => exit(),
  };
}

describe.each(["macOS", "Linux"])("%s host PTY boundary", (platform) => {
  async function fixture(pid = 100, operations = fakeOperations(), pty = fakePty(pid)) {
    const { snapshot, signal } = operations;
    const factory = (platform === "macOS" ? darwinHostTerminalFactory : linuxHostTerminalFactory)(
      pty,
      operations,
    );
    const guard = {
      paths: ["/fixture/protected"],
      ports: [12345],
      sockets: ["/fixture/engine.sock"],
    };
    const environment = { PATH: "/usr/bin:/bin", HOME: "/fixture", TERM: "xterm-256color" };
    const terminal = await factory(guard).spawn("/bin/sh", "/fixture/work", environment, 93, 31);
    processes.push(terminal);
    return {
      ...pty,
      terminal,
      snapshot,
      signal,
      environment,
    };
  }

  it.each([
    { failure: "rejects", alreadyGone: false },
    { failure: "rejects", alreadyGone: true },
    { failure: "times out", alreadyGone: false },
    { failure: "times out", alreadyGone: true },
  ])(
    "kills the spawned shell without tracking or polling when the first snapshot $failure (ESRCH: $alreadyGone)",
    async ({ failure, alreadyGone }) => {
      const operations = fakeOperations();
      const pty = fakePty();
      const message =
        failure === "rejects"
          ? "Terminal process lookup failed."
          : "Terminal process lookup timed out.";
      if (failure === "rejects") operations.snapshot.mockRejectedValueOnce(new Error(message));
      else operations.snapshot.mockReturnValueOnce(new Promise(() => {}));
      if (alreadyGone)
        pty.child.kill.mockImplementation(() => {
          throw Object.assign(new Error("Process already exited."), { code: "ESRCH" });
        });

      const opening = fixture(100, operations, pty);
      const rejected = expect(opening).rejects.toEqual(new Error(message));
      await vi.waitFor(() => expect(operations.snapshot).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(failure === "rejects" ? 0 : 2000);
      await rejected;

      expect(pty.spawn).toHaveBeenCalledOnce();
      expect(pty.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(processes).toEqual([]);
      expect(operations.signal).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5000);
      expect(operations.snapshot).toHaveBeenCalledExactlyOnceWith(2000);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("launches the login shell with only the supplied environment and macOS-only process guards", async () => {
    const f = await fixture();
    expect(f.spawn).toHaveBeenCalledOnce();
    const [binary, args, options] = f.spawn.mock.calls[0]! as unknown as [string, string[], object];
    if (platform === "macOS") {
      expect(binary).toBe("/usr/bin/sandbox-exec");
      expect(args.slice(2)).toEqual(["/bin/sh", "-l"]);
      expect(args[0]).toBe("-p");
      expect(args[1]).toContain('(subpath "/fixture/protected")');
      expect(args[1]).toContain('(remote ip "localhost:12345")');
      expect(args[1]).toContain('(remote unix-socket (literal "/fixture/engine.sock"))');
    } else {
      expect(binary).toBe("/bin/sh");
      expect(args).toEqual(["-l"]);
    }
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
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
  });

  it("remembers a detached descendant when the shell exits during cleanup", async () => {
    const f = await fixture();
    rows.push(row(101, 100, 101));
    await vi.advanceTimersByTimeAsync(500);
    rows = [row(101, 1, 101)];
    f.exit();
    const cleanup = f.terminal.killTree();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.signal).toHaveBeenCalledExactlyOnceWith(101, "SIGTERM");
    rows = [];
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
  });

  it("never signals a reused PID or adopts its children", async () => {
    const f = await fixture();
    rows = [row(100, 1, 100, "new-process"), row(101, 100, 100)];
    const cleanup = f.terminal.killTree();
    const rejected = expect(cleanup).rejects.toThrow("still closing");
    await vi.advanceTimersByTimeAsync(TERMINAL_CLEANUP_DEADLINE_MS - 500);
    await rejected;
    expect(f.signal).not.toHaveBeenCalled();
    rows = [];
    await f.terminal.killTree();
  });

  it("never adopts a reused shell PID after the original exited before the first lookup", async () => {
    rows = [];
    const f = await fixture();
    rows = [row(100, 1, 100, "new-process"), row(101, 100, 100)];
    const cleanup = f.terminal.killTree();
    const rejected = expect(cleanup).rejects.toThrow("still closing");
    await vi.advanceTimersByTimeAsync(TERMINAL_CLEANUP_DEADLINE_MS - 500);
    await rejected;
    expect(f.signal).not.toHaveBeenCalled();
    rows = [];
    await f.terminal.killTree();
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
    const rejected = expect(cleanup).rejects.toThrow("still closing");
    await vi.advanceTimersByTimeAsync(TERMINAL_CLEANUP_DEADLINE_MS - 500);
    await rejected;
    expect(f.signal.mock.calls.some(([pid]) => pid === 900 || pid === -100)).toBe(false);
    rows = [];
    await f.terminal.killTree();
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

  it("recovers from a slow background lookup and requires a fresh clean termination lookup", async () => {
    const f = await fixture();
    f.snapshot.mockReturnValueOnce(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.snapshot.mock.calls).toEqual([[2000], [2000]]);
    rows = [];
    await expect(f.terminal.killTree()).resolves.toBeUndefined();
    expect(f.snapshot.mock.calls).toEqual([[2000], [2000], [2000]]);
    expect(f.signal).not.toHaveBeenCalled();
  });

  it("does not let a stale in-flight background snapshot prove cleanup", async () => {
    const f = await fixture();
    f.snapshot.mockReturnValueOnce(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(500);
    rows = [];
    await expect(f.terminal.killTree()).resolves.toBeUndefined();
    expect(f.snapshot).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.snapshot).toHaveBeenCalledTimes(3);
  });

  it("recovers from a rejected background lookup without poisoning cleanup", async () => {
    const f = await fixture();
    f.snapshot.mockRejectedValueOnce(new Error("lookup failed"));
    await vi.advanceTimersByTimeAsync(500);
    rows = [];
    await expect(f.terminal.killTree()).resolves.toBeUndefined();
    expect(f.snapshot).toHaveBeenCalledTimes(3);
    expect(f.signal).not.toHaveBeenCalled();
  });

  it("retries a failed termination lookup before accepting a clean tree", async () => {
    const f = await fixture();
    rows = [];
    f.snapshot.mockRejectedValueOnce(new Error("lookup failed"));
    const cleanup = f.terminal.killTree();
    await vi.advanceTimersByTimeAsync(100);
    await expect(cleanup).resolves.toBeUndefined();
    expect(f.snapshot).toHaveBeenCalledTimes(3);
    expect(f.signal).not.toHaveBeenCalled();
  });

  it("keeps the session closing when termination lookups fail until the deadline", async () => {
    const f = await fixture();
    rows = [];
    f.snapshot.mockRejectedValue(new Error("lookup failed"));
    const cleanup = f.terminal.killTree();
    const rejected = expect(cleanup).rejects.toThrow("still closing");
    await vi.advanceTimersByTimeAsync(TERMINAL_CLEANUP_DEADLINE_MS - 500);
    await rejected;
    expect(Date.now()).toBe(TERMINAL_CLEANUP_DEADLINE_MS - 500);
    expect(f.snapshot.mock.calls.length).toBeGreaterThan(2);
    expect(f.signal).not.toHaveBeenCalled();
    expect(() => f.terminal.write(Uint8Array.of(1))).toThrow("closing");
    f.snapshot.mockImplementation(async () => [...rows]);
    await f.terminal.killTree();
  });

  it("bounds repeated unresponsive termination lookups by the cleanup deadline", async () => {
    const f = await fixture();
    rows = [];
    f.snapshot.mockImplementation(() => new Promise(() => {}));
    const cleanup = f.terminal.killTree();
    const rejected = expect(cleanup).rejects.toThrow("still closing");
    await vi.advanceTimersByTimeAsync(TERMINAL_CLEANUP_DEADLINE_MS - 500);
    await rejected;
    expect(Date.now()).toBe(TERMINAL_CLEANUP_DEADLINE_MS - 500);
    expect(f.snapshot.mock.calls.map(([timeout]) => timeout)).toEqual([
      2000, 2000, 2000, 2000, 2000, 1100,
    ]);
    expect(f.signal).not.toHaveBeenCalled();
    f.snapshot.mockImplementation(async () => [...rows]);
    await f.terminal.killTree();
  });

  it("shares one background snapshot per tick across terminals and tracks both trees", async () => {
    rows.push(row(200));
    const operations = fakeOperations();
    const first = await fixture(100, operations);
    const second = await fixture(200, operations);
    operations.snapshot.mockClear();
    rows.push(row(101, 100, 101), row(201, 200, 201));
    await vi.advanceTimersByTimeAsync(500);
    expect(operations.snapshot).toHaveBeenCalledExactlyOnceWith(2000);
    rows = [row(101, 1, 101), row(201, 1, 201)];
    first.exit();
    second.exit();
    const cleanup = Promise.all([first.terminal.killTree(), second.terminal.killTree()]);
    await vi.advanceTimersByTimeAsync(0);
    expect(operations.signal.mock.calls).toEqual([
      [101, "SIGTERM"],
      [201, "SIGTERM"],
    ]);
    rows = [];
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
  });

  it("continues polling until the last terminal closes, then stops", async () => {
    rows.push(row(200));
    const operations = fakeOperations();
    const first = await fixture(100, operations);
    const second = await fixture(200, operations);
    rows = [row(200)];
    await first.terminal.killTree();
    operations.snapshot.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(operations.snapshot).toHaveBeenCalledTimes(2);
    rows = [];
    await second.terminal.killTree();
    operations.snapshot.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(operations.snapshot).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never overlaps background lookups and restarts safely after the last terminal closes", async () => {
    const operations = fakeOperations();
    const first = await fixture(100, operations);
    let complete: (value: ProcessIdentity[]) => void = () => {};
    operations.snapshot.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(operations.snapshot).toHaveBeenCalledTimes(2);
    rows = [];
    await first.terminal.killTree();
    rows = [row(200)];
    const second = await fixture(200, operations);
    complete([]);
    await vi.advanceTimersByTimeAsync(0);
    operations.snapshot.mockClear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(operations.snapshot).toHaveBeenCalledTimes(2);
    const cleanup = second.terminal.killTree();
    await vi.advanceTimersByTimeAsync(0);
    expect(operations.signal).toHaveBeenCalledExactlyOnceWith(-200, "SIGTERM");
    rows = [];
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    expect(vi.getTimerCount()).toBe(0);
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
