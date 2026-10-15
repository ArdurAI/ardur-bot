import { expect, it } from "vitest";
import { nativePtyFixture, spawnedProcessAlive, until } from "./host-terminal-pty.test-support.js";
import { linuxProcessSnapshot } from "./host-terminal-pty-linux.js";

const linuxIt = it.skipIf(process.platform !== "linux");
linuxIt(
  "loads the staged Linux PTY, starts a session leader and reports resize",
  async () => {
    const f = await nativePtyFixture();
    try {
      const shell = (await linuxProcessSnapshot(2000)).find((row) => row.pid === f.pid)!;
      expect(shell.session).toBe(f.pid);
      expect(shell.group).toBe(f.pid);
      f.terminal.resize(111, 37);
      await f.run("resize");
      await until(() => f.output().includes("SIZE:111x37"));
    } finally {
      await f.close();
    }
  },
  45_000,
);
linuxIt(
  "Ctrl-C interrupts the foreground program and leaves the default shell usable",
  async () => {
    const f = await nativePtyFixture();
    try {
      await f.run("interrupt");
      let foreground = 0;
      await until(async () => {
        foreground = Number(await f.read("foreground.pid"));
        return foreground > 1;
      });
      await f.send("\x03");
      await until(async () => !(await spawnedProcessAlive(foreground)));
      await f.run("ready");
      await until(() => f.output().includes("READY:native-pty"));
    } finally {
      await f.close();
    }
  },
  45_000,
);
linuxIt(
  "awaits the shell, foreground parent and a child that left its session",
  async () => {
    const f = await nativePtyFixture();
    try {
      await f.run("tree");
      await until(async () => !!(await f.read("tree.json")) && !!(await f.read("detached.ready")));
      const children: number[] = JSON.parse(await f.read("tree.json"));
      const detached = children[1]!;
      await until(async () =>
        (await linuxProcessSnapshot(2000)).some(
          (row) => row.pid === detached && row.session === detached,
        ),
      );
      await f.terminal.killTree();
      for (const pid of [f.pid, ...children]) expect(await spawnedProcessAlive(pid)).toBe(false);
    } finally {
      await f.close();
    }
  },
  45_000,
);
