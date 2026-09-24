import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import {
  getHostEnvironment,
  hostBinaryCandidates,
  nativeEnvironment,
  resolveHostBinary,
} from "../host-environment.js";

export { nativeEnvironment } from "../host-environment.js";

export function nativeBinaryCandidates(
  name: "claude" | "codex",
  env: NodeJS.ProcessEnv,
  platform = process.platform,
) {
  return hostBinaryCandidates(name, env, platform);
}
export async function findNativeBinary(name: "claude" | "codex", env?: NodeJS.ProcessEnv) {
  env ??= (await getHostEnvironment()).env;
  return resolveHostBinary(name, env);
}

export type NativeSpawn = (
  binary: string,
  args: string[],
  cwd?: string,
) => ChildProcessWithoutNullStreams;
export const spawnNative: NativeSpawn = (binary, args, cwd) =>
  spawn(binary, args, {
    cwd,
    env: nativeEnvironment(),
    shell: false,
    stdio: "pipe",
    windowsHide: true,
    detached: process.platform !== "win32" && !process.send,
  });

export async function probeCommand(
  binary: string,
  args: string[],
  capture = false,
  start = spawnNative,
) {
  const child = start(binary, args);
  let output = "";
  child.stdin.end();
  child.stdout.on("data", (chunk: Buffer) => {
    if (capture && output.length < 1024) output += chunk.toString().slice(0, 1024 - output.length);
  });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return {
      code,
      version: capture ? output.trim().match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] : undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function* jsonLines(
  child: ChildProcessWithoutNullStreams,
): AsyncIterable<Record<string, unknown>> {
  let pending = "";
  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    pending += chunk;
    if (pending.length > 4 * 1024 * 1024) throw new Error("Runtime output exceeded its limit.");
    let index = pending.indexOf("\n");
    while (index >= 0) {
      const line = pending.slice(0, index).trim();
      pending = pending.slice(index + 1);
      if (line) {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error("Invalid runtime event.");
        yield value as Record<string, unknown>;
      }
      index = pending.indexOf("\n");
    }
  }
  if (pending.trim()) throw new Error("Incomplete runtime event.");
}

export async function stopNative(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  terminateNative(child, "SIGTERM");
  const timer = setTimeout(() => terminateNative(child, "SIGKILL"), 1_000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

export function terminateNative(
  child: ChildProcessWithoutNullStreams,
  signal: "SIGTERM" | "SIGKILL",
) {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    const system = process.env.SystemRoot ?? process.env.WINDIR;
    if (system && isAbsolute(system)) {
      const killer = spawn(
        join(system, "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/t", "/f"],
        { shell: false, windowsHide: true, stdio: "ignore", env: nativeEnvironment() },
      );
      killer.on("error", () => child.kill(signal));
      killer.unref();
      return;
    }
  } else {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* Already exited or a process stub. */
    }
  }
  child.kill(signal);
}

export class RuntimeQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;
  private bytes = 0;
  private failure?: unknown;
  push(item: T) {
    if (!this.ended) {
      const bytes = Buffer.byteLength(JSON.stringify(item));
      if (this.items.length >= 256 || this.bytes + bytes > 8 * 1024 * 1024) {
        this.end(new Error("Runtime output exceeded its limit."));
        return;
      }
      this.bytes += bytes;
      this.items.push(item);
      this.wake?.();
    }
  }
  end(error?: unknown) {
    if (this.ended) return;
    this.ended = true;
    this.failure = error;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const item = this.items.shift();
      if (item !== undefined) {
        this.bytes -= Buffer.byteLength(JSON.stringify(item));
        yield item;
        continue;
      }
      if (this.ended) {
        if (this.failure) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
