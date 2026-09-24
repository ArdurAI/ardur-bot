import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export interface HostServiceConfig {
  apiUrl: string;
  token: string;
  root: string;
  hostRoots: string[];
}
export interface HostSecretStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export function hostStorageAvailable(storage: HostSecretStorage, platform = process.platform) {
  return (
    storage.isEncryptionAvailable() &&
    (platform !== "linux" || storage.getSelectedStorageBackend?.() !== "basic_text")
  );
}
/** Neither the renderer nor Compose receives the pairing credential. */
export class HostServiceStore {
  private file: string;
  constructor(
    private readonly directory: string,
    private readonly storage: HostSecretStorage,
  ) {
    this.file = path.join(directory, "host-service.enc");
  }
  async read(): Promise<HostServiceConfig | null> {
    if (!hostStorageAvailable(this.storage)) return null;
    try {
      const encoded = await readPrivateFile(this.file, 256 * 1024);
      if (encoded === null) return null;
      return JSON.parse(
        this.storage.decryptString(Buffer.from(encoded, "base64")),
      ) as HostServiceConfig;
    } catch {
      return null;
    }
  }
  async write(config: HostServiceConfig) {
    if (!hostStorageAvailable(this.storage))
      throw new Error("Unlock secure storage, then try again.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writePrivateFile(
      this.file,
      this.storage.encryptString(JSON.stringify(config)).toString("base64"),
    );
  }
  async clear() {
    await rm(this.file, { force: true });
  }
}
export function hostServiceLaunch(options: {
  packaged: boolean;
  execPath: string;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform;
}) {
  return {
    command: options.execPath,
    args: options.packaged
      ? [path.join(options.resourcesPath, "host-service", "host-service.cjs")]
      : [
          "--import",
          path.join(options.appPath, "../../node_modules/tsx/dist/loader.mjs"),
          path.join(options.appPath, "../host-service/src/index.ts"),
        ],
    options: {
      shell: false,
      windowsHide: true,
      detached: (options.platform ?? process.platform) !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: hostServiceEnvironment(process.env, options.platform),
    } satisfies SpawnOptions,
  };
}
export function hostServiceEnvironment(source: NodeJS.ProcessEnv, platform = process.platform) {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ])
    if (source[key]) env[key] = source[key];
  if (platform === "win32") env.ELECTRON_NO_ATTACH_CONSOLE = "1";
  return env;
}
export function stopHostProcess(child: ChildProcess, platform = process.platform, start = spawn) {
  if (child.pid && platform === "win32") {
    const system = process.env.SystemRoot ?? process.env.WINDIR;
    if (system && path.win32.isAbsolute(system)) {
      const killer = start(
        path.win32.join(system, "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/t", "/f"],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      killer.on("error", () => child.kill("SIGKILL"));
      killer.unref();
      return;
    }
  }
  if (child.pid && platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      /* Group already exited. */
    }
  }
  child.kill("SIGKILL");
}

export type HostServiceSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;
/** The application owns this process; a BrowserWindow closing has no lifecycle hook here. */
export class HostServiceSupervisor {
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  private stable?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private failures = 0;
  private config?: HostServiceConfig;
  constructor(
    private readonly launch: ReturnType<typeof hostServiceLaunch>,
    private readonly changed: (connected: boolean) => void,
    private readonly startChild: HostServiceSpawn = spawn,
  ) {}
  start(config: HostServiceConfig) {
    if (!this.stopped && JSON.stringify(this.config) === JSON.stringify(config)) return;
    this.stop();
    this.config = config;
    this.stopped = false;
    this.spawn();
  }
  private spawn() {
    if (this.stopped || !this.config) return;
    try {
      const child = this.startChild(this.launch.command, this.launch.args, this.launch.options);
      this.child = child;
      child.once("spawn", () => {
        if (!this.stopped && this.config)
          child.send?.(this.config, (error) => {
            if (error) child.kill();
          });
      });
      child.on("message", (value: unknown) => {
        if (
          value &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "host-state" &&
          "connected" in value &&
          typeof value.connected === "boolean"
        )
          this.changed(value.connected);
      });
      let exited = false;
      const restart = () => {
        if (exited) return;
        exited = true;
        if (this.child !== child) return;
        this.child = undefined;
        stopHostProcess(child);
        clearTimeout(this.stable);
        this.changed(false);
        if (!this.stopped)
          this.timer = setTimeout(
            () => this.spawn(),
            Math.min(30_000, 500 * 2 ** Math.min(this.failures++, 6)),
          );
      };
      child.once("exit", restart);
      child.once("error", restart);
      this.stable = setTimeout(() => {
        this.failures = 0;
      }, 60_000);
      this.stable.unref();
    } catch {
      if (!this.stopped)
        this.timer = setTimeout(
          () => this.spawn(),
          Math.min(30_000, 500 * 2 ** Math.min(this.failures++, 6)),
        );
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.stable);
    const child = this.child;
    this.child = undefined;
    this.changed(false);
    if (!child) return;
    if (child.connected) child.send({ type: "stop" }, () => undefined);
    else child.kill();
    const timer = setTimeout(() => stopHostProcess(child), 2000);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      stopHostProcess(child);
    });
  }
}
export async function selectedHostRoot(folder: string) {
  if (!path.isAbsolute(folder) || folder.split(/[/\\]/u).includes(".."))
    throw new Error("Choose a folder.");
  return realpath(folder);
}
