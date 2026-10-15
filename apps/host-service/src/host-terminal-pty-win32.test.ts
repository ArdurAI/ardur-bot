import type { Win32NativeApi } from "@ardurbot/host-runtime/desktop-sandbox-win32-path";
import type { IPty } from "node-pty";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeConptyResources,
  win32HostTerminalFactory,
  windowsTerminalJob,
} from "./host-terminal-pty-win32.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});
function fixture() {
  let exit = () => {};
  const child = {
    pid: 100,
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    onExit: vi.fn((fn: () => void) => {
      exit = fn;
      return { dispose: vi.fn() };
    }),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
  };
  const spawn = vi.fn(() => child as unknown as IPty);
  let active = 1;
  const job = {
    assign: vi.fn(),
    terminate: vi.fn(),
    activeProcesses: vi.fn(() => active),
    close: vi.fn(),
  };
  const createJob = vi.fn(() => job);
  const dispose = vi.fn(async (_child: IPty) => {});
  const factory = win32HostTerminalFactory(
    { spawn },
    createJob,
    dispose,
  )({ paths: [], ports: [], sockets: [] });
  const open = () =>
    factory.spawn(
      "C:\\Windows\\System32\\cmd.exe",
      "C:\\fixture",
      { SystemRoot: "C:\\Windows" },
      80,
      24,
    );
  return {
    child,
    spawn,
    job,
    createJob,
    dispose,
    open,
    exit: () => exit(),
    active: (value: number) => {
      active = value;
    },
  };
}

describe("Windows ConPTY lifecycle", () => {
  it("creates the job before spawn, disables AutoRun and assigns only the spawned PID", async () => {
    const f = fixture();
    await f.open();
    expect(f.createJob.mock.invocationCallOrder[0]).toBeLessThan(
      f.spawn.mock.invocationCallOrder[0]!,
    );
    expect(f.spawn.mock.invocationCallOrder[0]).toBeLessThan(
      f.job.assign.mock.invocationCallOrder[0]!,
    );
    expect(f.job.assign).toHaveBeenCalledExactlyOnceWith(100);
    expect(f.spawn).toHaveBeenCalledWith("C:\\Windows\\System32\\cmd.exe", ["/d", "/q"], {
      cwd: "C:\\fixture",
      env: { SystemRoot: "C:\\Windows" },
      cols: 80,
      rows: 24,
      name: "xterm-256color",
      useConpty: true,
      useConptyDll: true,
    });
  });
  it("decodes split UTF-8 and forwards interrupt and resize", async () => {
    const f = fixture();
    const terminal = await f.open();
    terminal.write(Uint8Array.of(0xe2));
    expect(f.child.write).not.toHaveBeenCalled();
    terminal.write(Uint8Array.of(0x82, 0xac, 3));
    expect(f.child.write).toHaveBeenCalledExactlyOnceWith("€\x03");
    terminal.resize(120, 40);
    expect(f.child.resize).toHaveBeenCalledWith(120, 40);
  });
  it("waits for every job member after shell exit before closing its handle", async () => {
    const f = fixture();
    const terminal = await f.open();
    f.exit();
    const cleanup = terminal.killTree();
    expect(terminal.killTree()).toBe(cleanup);
    expect(f.job.terminate).toHaveBeenCalledOnce();
    expect(f.job.close).not.toHaveBeenCalled();
    expect(f.dispose).not.toHaveBeenCalled();
    expect(() => terminal.write(Buffer.from("input"))).toThrow("closing");
    expect(() => terminal.resize(80, 24)).toThrow("closing");
    f.active(0);
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    expect(f.job.close).toHaveBeenCalledOnce();
    expect(f.dispose).toHaveBeenCalledExactlyOnceWith(f.child);
    expect(f.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      f.job.close.mock.invocationCallOrder[0]!,
    );
    expect(f.job.assign).toHaveBeenCalledOnce();
    // No cleanup-time PID lookup or node-pty console-list kill can target a reused PID.
    expect(f.child.kill).not.toHaveBeenCalled();
  });
  it.each(["surviving members", "query failure", "termination failure", "close failure"])(
    "rejects within 9.5 seconds and can retry after %s",
    async (failure) => {
      const f = fixture();
      const terminal = await f.open();
      if (failure === "query failure")
        f.job.activeProcesses.mockImplementation(() => {
          throw new Error("query");
        });
      if (failure === "termination failure")
        f.job.terminate.mockImplementation(() => {
          throw new Error("terminate");
        });
      if (failure === "close failure") {
        f.active(0);
        f.job.close.mockImplementation(() => {
          throw new Error("close");
        });
      }
      const cleanup = terminal.killTree();
      const rejected = expect(cleanup).rejects.toThrow("still closing");
      await vi.advanceTimersByTimeAsync(9500);
      await rejected;
      expect(Date.now()).toBe(9500);
      expect(() => terminal.write(Buffer.from("input"))).toThrow("closing");
      f.job.terminate.mockImplementation(() => {});
      f.job.activeProcesses.mockReturnValue(0);
      f.job.close.mockImplementation(() => {});
      await terminal.killTree();
      expect(f.job.close).toHaveBeenCalled();
    },
  );
  it("closes the job and refuses opening when spawning or assignment fails", async () => {
    for (const failAt of ["spawn", "assign"]) {
      const f = fixture();
      if (failAt === "spawn")
        f.spawn.mockImplementation(() => {
          throw new Error("spawn failed");
        });
      else
        f.job.assign.mockImplementation(() => {
          throw new Error("assignment failed");
        });
      await expect(f.open()).rejects.toThrow("failed");
      expect(f.job.close).toHaveBeenCalledOnce();
      expect(f.child.kill).toHaveBeenCalledTimes(failAt === "assign" ? 1 : 0);
    }
  });
  it("does not spawn when job creation fails", async () => {
    const f = fixture();
    f.createJob.mockImplementation(() => {
      throw new Error("job unavailable");
    });
    await expect(f.open()).rejects.toThrow("unavailable");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("refuses an unapproved shell before allocating a job", async () => {
    const f = fixture();
    await expect(
      win32HostTerminalFactory(
        { spawn: f.spawn },
        f.createJob,
      )({ paths: [], ports: [], sockets: [] }).spawn("powershell.exe", "C:\\fixture", {}, 80, 24),
    ).rejects.toThrow("Unsupported");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.createJob).not.toHaveBeenCalled();
  });
});

function nativeFixture() {
  const calls = {
    CreateJobObjectW: vi.fn(() => "job"),
    SetInformationJobObject: vi.fn(() => 1),
    AssignProcessToJobObject: vi.fn(() => 1),
    OpenProcess: vi.fn(() => "process-handle"),
    TerminateJobObject: vi.fn(() => 1),
    TerminateProcess: vi.fn(() => 1),
    QueryInformationJobObject: vi.fn((_job: unknown, _kind: unknown, output: Buffer) => {
      output.writeUInt32LE(2, 40);
      return 1;
    }),
    CloseHandle: vi.fn(() => 1),
  };
  const native = {
    load: vi.fn(() => ({
      func: (signature: string) => {
        const name = signature.match(/__stdcall (\w+)\(/)![1]!;
        return calls[name as keyof typeof calls];
      },
    })),
    struct: vi.fn(),
    sizeof: vi.fn(),
  } as unknown as Win32NativeApi;
  return { native, calls };
}
describe("Windows Job Object FFI", () => {
  it("sets kill-on-close, excludes breakaway, pins the shell handle and queries active count", () => {
    const f = nativeFixture();
    const job = windowsTerminalJob(f.native);
    const setArgs = f.calls.SetInformationJobObject.mock.calls[0] as unknown as [
      string,
      number,
      Buffer,
      number,
    ];
    expect(setArgs[0]).toBe("job");
    expect(setArgs[1]).toBe(9);
    expect(setArgs[2].length).toBe(144);
    expect(setArgs[2].readUInt32LE(16)).toBe(0x2000);
    job.assign(100);
    expect(f.calls.OpenProcess).toHaveBeenCalledExactlyOnceWith(0x101, 0, 100);
    expect(f.calls.AssignProcessToJobObject).toHaveBeenCalledExactlyOnceWith(
      "job",
      "process-handle",
    );
    expect(f.calls.CloseHandle).toHaveBeenCalledExactlyOnceWith("process-handle");
    expect(job.activeProcesses()).toBe(2);
    job.terminate();
    expect(f.calls.TerminateJobObject).toHaveBeenCalledExactlyOnceWith("job", 1);
    job.close();
    job.close();
    expect(job.activeProcesses()).toBe(0);
    expect(f.calls.OpenProcess).toHaveBeenCalledOnce();
    expect(f.calls.CloseHandle.mock.calls).toEqual([["process-handle"], ["job"]]);
  });
  it.each([0, 1, -100, 1.5, NaN])("refuses invalid PID %s without any process lookup", (pid) => {
    const f = nativeFixture();
    const job = windowsTerminalJob(f.native);
    expect(() => job.assign(pid)).toThrow("Invalid");
    expect(f.calls.OpenProcess).not.toHaveBeenCalled();
    job.close();
  });
  it("terminates only the pinned shell if job assignment is refused", () => {
    const f = nativeFixture();
    f.calls.AssignProcessToJobObject.mockReturnValue(0);
    const job = windowsTerminalJob(f.native);
    expect(() => job.assign(100)).toThrow("assignment failed");
    expect(f.calls.TerminateProcess).toHaveBeenCalledExactlyOnceWith("process-handle", 1);
    expect(f.calls.CloseHandle).toHaveBeenCalledExactlyOnceWith("process-handle");
    job.close();
  });
  it("refuses job creation, limit setup and process-handle failures", () => {
    for (const at of ["CreateJobObjectW", "SetInformationJobObject", "OpenProcess"] as const) {
      const f = nativeFixture();
      f.calls[at].mockReturnValue(0 as never);
      if (at === "OpenProcess") {
        const job = windowsTerminalJob(f.native);
        expect(() => job.assign(100)).toThrow("handle unavailable");
        job.close();
      } else expect(() => windowsTerminalJob(f.native)).toThrow("failed");
      expect(f.calls.AssignProcessToJobObject).not.toHaveBeenCalled();
    }
  });
});

describe("pinned ConPTY resource cleanup", () => {
  it("closes only the owned pipes and awaits its output worker without a PID kill", async () => {
    const incoming = { destroy: vi.fn() };
    const outgoing = { destroy: vi.fn() };
    let finish!: () => void;
    const worker = {
      terminate: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const child = {
      kill: vi.fn(),
      _agent: {
        _inSocket: incoming,
        _outSocket: outgoing,
        _conoutSocketWorker: { _worker: worker },
      },
    };
    let finished = false;
    const closing = closeConptyResources(child as unknown as IPty).then(() => {
      finished = true;
    });
    expect(incoming.destroy).toHaveBeenCalledOnce();
    expect(outgoing.destroy).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    finish();
    await closing;
    expect(finished).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });
  it("refuses an unexpected backend layout instead of claiming resource cleanup", async () => {
    await expect(closeConptyResources({} as IPty)).rejects.toThrow("unavailable");
  });
  it("bounds a stuck output worker inside the same cleanup deadline", async () => {
    const f = fixture();
    f.dispose.mockReturnValue(new Promise(() => {}));
    f.active(0);
    const terminal = await f.open();
    const closing = terminal.killTree();
    const rejected = expect(closing).rejects.toThrow("still closing");
    await vi.advanceTimersByTimeAsync(9500);
    await rejected;
    expect(f.job.close).not.toHaveBeenCalled();
    f.dispose.mockResolvedValue(undefined);
    await terminal.killTree();
    expect(f.job.close).toHaveBeenCalledOnce();
  });
});
