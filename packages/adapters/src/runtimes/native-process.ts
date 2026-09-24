import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/** Deliberately copy only OS discovery variables. Never inherit provider or agent secrets. */
export function nativeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "WINDIR",
    "LOCALAPPDATA",
    "APPDATA",
    "USERPROFILE",
    "LANG",
    "LC_ALL",
  ]) {
    if (source[key]) env[key] = source[key];
  }
  return env;
}

export async function findNativeBinary(name: "claude" | "codex", env = nativeEnvironment()) {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    // Never execute a shell wrapper (.cmd/.bat) to discover a binary on Windows.
    const candidate = join(directory, process.platform === "win32" ? `${name}.exe` : name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* Try the next host PATH entry. */
    }
  }
  return undefined;
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
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

export class RuntimeQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private wake?: () => void;
  private ended = false;
  private failure?: unknown;
  push(item: T) {
    if (!this.ended) {
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
