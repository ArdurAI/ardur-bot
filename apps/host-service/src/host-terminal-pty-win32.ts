import type { Socket } from "node:net";
import { release } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Worker } from "node:worker_threads";
import type { Win32NativeApi } from "@ardurbot/host-runtime/desktop-sandbox-win32-path";
import type { GuardedHostTerminalFactory } from "@ardurbot/host-runtime/host-terminal";
import { TERMINAL_CLEANUP_DEADLINE_MS } from "@ardurbot/host-runtime/terminal-cleanup";
import type { IPty } from "node-pty";
import type { PtyModule } from "./host-terminal-pty.js";
import { terminalProcess } from "./host-terminal-pty.js";

export interface WindowsTerminalJob {
  assign(pid: number): void;
  terminate(): void;
  activeProcesses(): number;
  close(): void;
}

/** A private, non-inheritable job. No breakaway flags: detached children stay owned. */
export function windowsTerminalJob(native: Win32NativeApi): WindowsTerminalJob {
  if (!["x64", "arm64"].includes(process.arch))
    throw new Error("Unsupported terminal architecture.");
  const kernel = native.load("kernel32.dll");
  const create = kernel.func("void * __stdcall CreateJobObjectW(void *attributes, void *name)");
  const set = kernel.func(
    "int __stdcall SetInformationJobObject(void *job, int kind, void *data, uint32_t size)",
  );
  const assign = kernel.func("int __stdcall AssignProcessToJobObject(void *job, void *process)");
  const open = kernel.func(
    "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
  );
  const terminate = kernel.func("int __stdcall TerminateJobObject(void *job, uint32_t code)");
  const terminateProcess = kernel.func(
    "int __stdcall TerminateProcess(void *process, uint32_t code)",
  );
  const query = kernel.func(
    "int __stdcall QueryInformationJobObject(void *job, int kind, void *data, uint32_t size, void *returned)",
  );
  const close = kernel.func("int __stdcall CloseHandle(void *handle)");
  const job = create(null, null);
  if (!job) throw new Error("Terminal job creation failed.");
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on the supported 64-bit Windows targets.
  // BasicLimitInformation.LimitFlags is at byte 16; KILL_ON_JOB_CLOSE = 0x2000.
  const limits = Buffer.alloc(144);
  limits.writeUInt32LE(0x2000, 16);
  if (!set(job, 9, limits, limits.length)) {
    close(job);
    throw new Error("Terminal job limits failed.");
  }
  let closed = false;
  let assigned = false;
  return {
    assign(pid) {
      if (closed || assigned || !Number.isSafeInteger(pid) || pid <= 1)
        throw new Error("Invalid terminal PID.");
      // The handle pins this process identity. Never reopen a PID during cleanup.
      const handle = open(0x100 | 0x1, 0, pid); // SET_QUOTA | TERMINATE
      if (!handle) throw new Error("Terminal process handle unavailable.");
      try {
        if (!assign(job, handle)) {
          if (!terminateProcess(handle, 1)) throw new Error("Terminal process is still closing.");
          throw new Error("Terminal job assignment failed.");
        }
        assigned = true;
      } finally {
        close(handle);
      }
    },
    terminate() {
      if (!closed && !terminate(job, 1)) throw new Error("Terminal job is still closing.");
    },
    activeProcesses() {
      if (closed) return 0;
      const accounting = Buffer.alloc(48);
      if (!query(job, 1, accounting, accounting.length, null))
        throw new Error("Terminal job lookup failed.");
      // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION (winnt.h): four LARGE_INTEGER times
      // (0-31), TotalPageFaultCount (32), TotalProcesses (36, lifetime count),
      // ActiveProcesses (40, live members), TotalTerminatedProcesses (44).
      return accounting.readUInt32LE(40);
    },
    close() {
      if (!closed) {
        if (!close(job)) throw new Error("Terminal job close failed.");
        closed = true;
      }
    },
  };
}

/**
 * node-pty 1.1.0's public kill enumerates console PIDs with the system ConPTY
 * backend. Its released ConPTY DLL lifetime lets the console follow shell exit;
 * close only our sockets and output worker after the Job Object is empty.
 * Keep this narrow compatibility seam pinned and covered by native runner tests.
 */
export async function closeConptyResources(child: IPty): Promise<void> {
  const agent = (
    child as IPty & {
      _agent?: {
        _inSocket?: Socket;
        _outSocket?: Socket;
        _conoutSocketWorker?: { _worker?: Worker };
      };
    }
  )._agent;
  const worker = agent?._conoutSocketWorker?._worker;
  if (!agent?._inSocket?.destroy || !agent._outSocket?.destroy || !worker?.terminate)
    throw new Error("Terminal resource cleanup unavailable.");
  agent._inSocket.destroy();
  agent._outSocket.destroy();
  await worker.terminate();
}

async function withinDeadline(cleanup: Promise<void>, remaining: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Terminal process tree is still closing.")),
          Math.max(0, remaining),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** ConPTY and Job Objects have separate lifetimes; shell exit alone is not cleanup. */
export function win32HostTerminalFactory(
  pty: PtyModule,
  createJob: () => WindowsTerminalJob,
  dispose: (child: IPty) => Promise<void> = closeConptyResources,
): GuardedHostTerminalFactory {
  return () => ({
    async spawn(shell, cwd, env, cols, rows) {
      // /d disables cmd AutoRun: no profile/user input runs before job assignment.
      if (path.win32.basename(shell).toLowerCase() !== "cmd.exe")
        throw new Error("Unsupported terminal shell.");
      if (process.platform === "win32" && Number(release().split(".")[2]) < 18309)
        throw new Error("ConPTY is unavailable on this Windows version.");
      const job = createJob();
      let child: ReturnType<PtyModule["spawn"]> | undefined;
      try {
        child = pty.spawn(shell, ["/d", "/q"], {
          cwd,
          env: { ...env },
          cols,
          rows,
          name: "xterm-256color",
          useConpty: true,
          useConptyDll: true,
        });
        job.assign(child.pid);
      } catch (error) {
        try {
          job.close();
        } finally {
          if (child) {
            child.kill();
            await withinDeadline(dispose(child), TERMINAL_CLEANUP_DEADLINE_MS - 500);
          }
        }
        throw error;
      }
      const spawned = child;
      let cleanup: Promise<void> | undefined;
      const decoder = new StringDecoder("utf8");
      return terminalProcess(
        spawned,
        () => {
          cleanup ??= (async () => {
            const deadline = Date.now() + TERMINAL_CLEANUP_DEADLINE_MS - 500;
            for (;;) {
              try {
                job.terminate();
                if (job.activeProcesses() === 0) {
                  await withinDeadline(dispose(spawned), deadline - Date.now());
                  if (Date.now() >= deadline)
                    throw new Error("Terminal process tree is still closing.");
                  job.close();
                  return;
                }
              } catch {
                // A failed job query is not evidence of an empty job. Retain for retry.
              }
              const remaining = deadline - Date.now();
              if (remaining <= 0) throw new Error("Terminal process tree is still closing.");
              await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining)));
            }
          })().catch((error) => {
            cleanup = undefined;
            throw error;
          });
          return cleanup;
        },
        (bytes) => {
          // Windows node-pty consumes strings; frames can split UTF-8 code points.
          const text = decoder.write(Buffer.from(bytes));
          if (text) spawned.write(text);
        },
      );
    },
  });
}
