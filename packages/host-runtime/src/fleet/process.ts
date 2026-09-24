import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import type { ProcessEvent } from "@ardurbot/adapter-kit";
import { getHostEnvironment, resolveHostBinary } from "../host-environment.js";
import { RuntimeQueue, stopNative } from "../runtimes/native-process.js";

export interface FleetProcess {
  start(name: string, argv: string[]): Promise<ChildProcessWithoutNullStreams>;
  run(
    name: string,
    argv: string[],
    signal: AbortSignal,
    input?: Uint8Array,
    limit?: number,
  ): Promise<{ stdout: Buffer; stderr: Buffer; code: number }>;
}
export const systemFleetProcess: FleetProcess = {
  async start(name, argv) {
    if (argv.some((arg) => arg.includes("\0"))) throw new Error("Invalid command argument.");
    const { env } = await getHostEnvironment();
    const executable = await resolveHostBinary(name, env);
    if (!executable) throw new Error(`Install ${name} on this computer and try again.`);
    return spawn(executable, argv, {
      env,
      shell: false,
      windowsHide: true,
      stdio: "pipe",
      detached: process.platform !== "win32" && !process.send,
    });
  },
  async run(name, argv, signal, input, limit = 16 * 1024 * 1024) {
    signal.throwIfAborted();
    const child = await this.start(name, argv);
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let size = 0;
    return new Promise((resolve, reject) => {
      const abort = () => {
        void stopNative(child);
        reject(new Error("Computer operation stopped."));
      };
      signal.addEventListener("abort", abort, { once: true });
      const collect = (target: Buffer[], bytes: Buffer) => {
        size += bytes.length;
        if (size > limit) {
          void stopNative(child);
          reject(new Error("Computer output exceeds its limit."));
        } else target.push(bytes);
      };
      child.stdout.on("data", (bytes: Buffer) => collect(stdout, bytes));
      child.stderr.on("data", (bytes: Buffer) => collect(stderr, bytes));
      child.once("error", () => reject(new Error("Computer command could not start.")));
      child.stdin.on("error", () => undefined);
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code: code ?? 1 });
      });
      child.stdin.end(input);
      if (signal.aborted) abort();
    });
  },
};

export async function* streamFleetProcess(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal,
  input?: Uint8Array,
): AsyncIterable<ProcessEvent> {
  const queue = new RuntimeQueue<ProcessEvent>();
  let bytes = 0;
  const abort = () => {
    void stopNative(child);
    queue.end(new Error("Computer operation stopped."));
  };
  const receive = (type: "stdout" | "stderr", data: string) => {
    bytes += Buffer.byteLength(data);
    if (bytes > 8 * 1024 * 1024) {
      abort();
      return;
    }
    queue.push({ type, data });
  };
  child.stdout.setEncoding("utf8").on("data", (data: string) => receive("stdout", data));
  child.stderr.setEncoding("utf8").on("data", (data: string) => receive("stderr", data));
  child.once("error", () => queue.end(new Error("Computer command could not start.")));
  child.stdin.on("error", () => undefined);
  child.once("close", (code) => {
    queue.push({ type: "exit", code: code ?? 1 });
    queue.end();
  });
  signal.addEventListener("abort", abort, { once: true });
  child.stdin.end(input);
  try {
    if (signal.aborted) abort();
    yield* queue;
  } finally {
    signal.removeEventListener("abort", abort);
    await stopNative(child);
  }
}

/** OpenSSH joins remote arguments with spaces; quote each argument for that second parser. */
export function quoteRemoteArg(value: string) {
  if (value.includes("\0")) throw new Error("Invalid command argument.");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
export function remoteArgv(argv: string[]) {
  if (!argv.length) throw new Error("A command is required.");
  return argv.map(quoteRemoteArg).join(" ");
}
