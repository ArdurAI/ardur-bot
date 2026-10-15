import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HostTerminalProcess } from "@ardurbot/host-runtime/host-terminal";
// @ts-expect-error Build entry point is intentionally JavaScript.
import { stageLinuxPty, stageWindowsNativeAddons, stageWindowsPty } from "../build.mjs";
import { loadHostPty } from "./host-terminal-pty.js";
import { linuxHostTerminalFactory, parseLinuxProcessStat } from "./host-terminal-pty-linux.js";
import { win32HostTerminalFactory, windowsTerminalJob } from "./host-terminal-pty-win32.js";
import { loadWin32NativeAddon } from "./native-addon.js";

export async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("PTY assertion timed out.");
    await delay(25);
  }
}
/** Only call for PIDs written by this fixture's own children. */
export async function spawnedProcessAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Invalid fixture PID.");
  try {
    if (process.platform === "linux")
      return !parseLinuxProcessStat(await readFile(`/proc/${pid}/stat`, "utf8")).zombie;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

let staged:
  | Promise<{
      pty: NonNullable<ReturnType<typeof loadHostPty>>;
      native: ReturnType<typeof loadWin32NativeAddon>;
    }>
  | undefined;
async function stagedRuntime() {
  staged ??= (async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "host-pty-runtime-")));
    const windows = process.platform === "win32";
    if (windows) {
      await stageWindowsNativeAddons(root);
      await stageWindowsPty(root);
    } else await stageLinuxPty(root);
    const bundle = path.join(root, "host-service.cjs");
    const pty = loadHostPty(bundle)!;
    const native = windows ? loadWin32NativeAddon(bundle) : undefined;
    if (windows && !native) throw new Error("Staged Windows FFI unavailable.");
    // Native DLLs cannot be unlinked on Windows until the worker exits. These
    // test-runtime files stay in the runner temp directory; workspaces are removed.
    return { pty, native };
  })();
  return staged;
}

export async function nativePtyFixture() {
  const { pty, native } = await stagedRuntime();
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "host-native-pty-")));
  const windows = process.platform === "win32";
  let terminal: HostTerminalProcess | undefined;
  try {
    let pid = 0;
    const wrapped = {
      spawn: (...args: Parameters<typeof pty.spawn>) => {
        const child = pty.spawn(...args);
        pid = child.pid;
        return child;
      },
    };
    const factory = windows
      ? win32HostTerminalFactory(wrapped, () => windowsTerminalJob(native!))
      : linuxHostTerminalFactory(wrapped);
    terminal = await factory({ paths: [], ports: [], sockets: [] }).spawn(
      windows
        ? path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32/cmd.exe")
        : "/bin/sh",
      directory,
      windows
        ? {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            TEMP: directory,
            USERPROFILE: directory,
          }
        : { PATH: "/usr/bin:/bin", HOME: directory, SHELL: "/bin/sh", TERM: "xterm-256color" },
      80,
      24,
    );
    const opened = terminal;
    let output = "";
    const dispose = terminal.onData((bytes) => {
      output += Buffer.from(bytes).toString("utf8");
    });
    const send = (command: string) => opened.write(Buffer.from(command));
    const script = path.join(directory, "fixture.cjs");
    // Parent waits so the Linux poller has a discoverable lineage for setsid children.
    await writeFile(
      script,
      `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.argv[2];
if (mode === 'resize') { console.log('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows); }
else if (mode === 'interrupt') {
  process.on('SIGINT', () => process.exit(130));
  fs.writeFileSync('foreground.pid', String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === 'tree') {
  const child = spawn(process.execPath, [__filename, 'detached'], { detached: true, stdio: 'ignore' });
  child.unref();
  fs.writeFileSync('tree.json', JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 1000);
} else if (mode === 'detached') {
  fs.writeFileSync('detached.ready', String(process.pid));
  setInterval(() => {}, 1000);
} else { console.log('READY:' + 'native-pty'); }
`,
    );
    const quote = (value: string) =>
      windows ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
    const run = (mode: string) =>
      send(`${quote(process.execPath)} ${quote(script)} ${mode}${windows ? "\r" : "\n"}`);
    const read = (name: string) =>
      readFile(path.join(directory, name), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
    return {
      pid,
      directory,
      terminal: opened,
      send,
      run,
      read,
      output: () => output,
      async close() {
        try {
          await opened.killTree();
        } finally {
          dispose();
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await terminal?.killTree();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
