import { execFile } from "node:child_process";
import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { StepReceipt } from "./store.js";

const execFileAsync = promisify(execFile);
export interface CommandFile {
  kind: "missing" | "link" | "file";
  target?: string;
  identity?: string;
}
export interface CommandBoundary {
  inspect(file: string): Promise<CommandFile>;
  resolveOnPath(name: string): Promise<string | null>;
  version(file: string): Promise<string | null>;
  ensure(dir: string): Promise<void>;
  link(target: string, file: string): Promise<void>;
}

export function realCommandBoundary(): CommandBoundary {
  return {
    inspect: async (file) => {
      try {
        const entry = await lstat(file);
        return entry.isSymbolicLink()
          ? {
              kind: "link",
              target: await readlink(file),
              identity: await realpath(file).catch(() => undefined),
            }
          : { kind: "file", identity: await realpath(file) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
        throw error;
      }
    },
    resolveOnPath: async (name) => {
      if (name !== "ardur") return null;
      try {
        const result = await execFileAsync("/bin/sh", ["-c", "command -v ardur"], {
          timeout: 3000,
        });
        const resolved = result.stdout.trim();
        return path.isAbsolute(resolved) ? resolved : null;
      } catch {
        return null;
      }
    },
    version: async (file) => {
      try {
        return (await execFileAsync(file, ["--version"], { timeout: 3000 })).stdout.trim();
      } catch {
        return null;
      }
    },
    ensure: async (dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    },
    link: (target, file) => symlink(target, file),
  };
}

export type CommandCheck = "ready" | "needed" | "waiting-path" | "collision";
export class ArdurCommandInstaller {
  readonly ownedPath: string;
  constructor(
    private readonly target: string,
    private readonly version: string,
    userDataDir: string,
    private readonly files: CommandBoundary,
  ) {
    this.ownedPath = path.join(userDataDir, "bin", "ardur");
  }

  async check(): Promise<CommandCheck> {
    const resolved = await this.files.resolveOnPath("ardur");
    const owned = await this.files.inspect(this.ownedPath);
    const targetIdentity = (await this.files.inspect(this.target)).identity;
    if (owned.kind !== "missing" && (owned.kind !== "link" || owned.target !== this.target))
      return "collision";
    if (targetIdentity && owned.kind === "link" && owned.identity !== targetIdentity)
      return "collision";
    if (resolved) {
      const entry = await this.files.inspect(resolved);
      if (targetIdentity) {
        if (entry.identity !== targetIdentity) return "collision";
      } else if (
        resolved !== this.target &&
        resolved !== this.ownedPath &&
        entry.target !== this.target
      ) {
        return "collision";
      }
      const version = await this.files.version(resolved);
      if (version !== this.version) return "collision";
      return "ready";
    }
    return owned.kind === "link" ? "waiting-path" : "needed";
  }

  async install(): Promise<StepReceipt> {
    const prior = await this.check();
    if (prior === "collision") throw new Error("command-collision");
    if (prior === "ready") return { kind: "reused", proof: "matching-command" };
    if (prior === "waiting-path") return { kind: "owned", proof: "owned-link" };
    await this.files.ensure(path.dirname(this.ownedPath));
    // symlink at the final name is atomic and refuses an existing name on every platform.
    await this.files.link(this.target, this.ownedPath);
    return { kind: "owned", proof: "owned-link" };
  }

  /** Keep a completed link on cancellation; a retry verifies it before claiming success. */
  async reconcile(): Promise<void> {
    const owned = await this.files.inspect(this.ownedPath);
    const targetIdentity = (await this.files.inspect(this.target)).identity;
    if (
      owned.kind !== "missing" &&
      (owned.kind !== "link" ||
        owned.target !== this.target ||
        (targetIdentity !== undefined && owned.identity !== targetIdentity))
    ) {
      throw new Error("command-ownership-uncertain");
    }
  }
}
