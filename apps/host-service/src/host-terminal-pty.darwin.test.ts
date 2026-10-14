import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
// @ts-expect-error The build entry point is intentionally JavaScript.
import { stageDarwinPty } from "../build.mjs";
import {
  darwinHostTerminalFactory,
  darwinProcessSnapshot,
  loadDarwinPty,
} from "./host-terminal-pty.js";

async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("PTY assertion timed out.");
    await delay(25);
  }
}

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "host-real-pty-")));
  await stageDarwinPty(directory);
  const pty = loadDarwinPty(path.join(directory, "host-service.cjs"))!;
  let pid = 0;
  const factory = darwinHostTerminalFactory({
    spawn: (...args) => {
      const child = pty.spawn(...args);
      pid = child.pid;
      return child;
    },
  });
  try {
    const terminal = await factory({ paths: [], ports: [], sockets: [] }).spawn(
      "/bin/sh",
      directory,
      { PATH: "/usr/bin:/bin", HOME: directory, SHELL: "/bin/sh", TERM: "xterm-256color" },
      80,
      24,
    );
    let output = "";
    const dispose = terminal.onData((bytes) => {
      output += Buffer.from(bytes).toString("utf8");
    });
    const send = (command: string) => terminal.write(Buffer.from(command));
    await send("stty -echo; printf 'PTY-%s\\n' READY\n");
    await until(() => output.includes("PTY-READY"));
    return {
      terminal,
      pid,
      directory,
      send,
      output: () => output,
      async close() {
        try {
          await terminal.killTree();
        } finally {
          dispose();
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

const darwinIt = it.skipIf(process.platform !== "darwin");

darwinIt(
  "receives real PTY output and reports resized rows and columns",
  async () => {
    const f = await fixture();
    try {
      await f.terminal.resize(111, 37);
      await f.send("stty size; printf 'OUTPUT-%s\\n' OK\n");
      await until(() => f.output().includes("OUTPUT-OK"));
      expect(f.output()).toMatch(/37\s+111/);
    } finally {
      await f.close();
    }
  },
  20_000,
);

darwinIt(
  "Ctrl-C interrupts a foreground sleep and leaves the shell usable",
  async () => {
    const f = await fixture();
    let foreground = 0;
    try {
      await f.send("sleep 300\n");
      await until(async () => {
        const children = (await darwinProcessSnapshot(250)).filter(
          (row) => row.parent === f.pid && !row.zombie,
        );
        foreground = children[0]?.pid ?? 0;
        return foreground > 1;
      });
      await f.send("\x03");
      await f.send("printf 'AFTER-%s\\n' INTERRUPT\n");
      await until(() => f.output().includes("AFTER-INTERRUPT"));
      await until(
        async () =>
          !(await darwinProcessSnapshot(250)).some((row) => row.pid === foreground && !row.zombie),
      );
    } finally {
      await f.close();
    }
  },
  20_000,
);

darwinIt(
  "kills background and nohup children in a detached session before resolving",
  async () => {
    const f = await fixture();
    let closed = false;
    try {
      // Perl is part of macOS. Fork before setsid so the child is not already a
      // process-group leader; its parent waits, preserving a discoverable lineage.
      // Interactive bash expands `!"` as history, so `$!` stays unquoted at the end.
      await f.send("sleep 300 & echo BG:$!\n");
      await f.send(
        'nohup /usr/bin/perl -MPOSIX -e \'$|=1; my $p=fork(); defined($p) or die; if ($p) { print "DETACHED:$p\\n"; waitpid($p,0); } else { POSIX::setsid() >= 0 or die; $SIG{HUP}="IGNORE"; exec "/bin/sleep", "300"; }\' >detached.log 2>&1 </dev/null &\n',
      );
      let detached = 0;
      await until(async () => {
        const log = await readFile(path.join(f.directory, "detached.log"), "utf8").catch(() => "");
        detached = Number(log.match(/DETACHED:(\d+)/)?.[1] ?? 0);
        if (!detached) return false;
        const rows = await darwinProcessSnapshot(250);
        return rows.some((row) => row.pid === detached && row.group === detached);
      });
      // Terminal output arrives asynchronously, like the detached child's log.
      let background = 0;
      await until(async () => {
        background = Number(f.output().match(/BG:(\d+)/)?.[1] ?? 0);
        return background > 1;
      });
      // Give the live ancestry tracker one observation before reparenting on exit.
      await delay(100);
      await f.terminal.killTree();
      const remaining = await darwinProcessSnapshot(250);
      for (const pid of [f.pid, background, detached])
        expect(remaining.some((row) => row.pid === pid && !row.zombie)).toBe(false);
      await f.close();
      closed = true;
    } finally {
      if (!closed) await f.close();
    }
  },
  20_000,
);
