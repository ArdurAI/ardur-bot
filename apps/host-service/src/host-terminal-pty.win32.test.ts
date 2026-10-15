import { expect, it } from "vitest";
import { nativePtyFixture, spawnedProcessAlive, until } from "./host-terminal-pty.test-support.js";

const windowsIt = it.skipIf(process.platform !== "win32");
windowsIt(
  "loads staged ConPTY workers and reports resized columns and rows",
  async () => {
    const f = await nativePtyFixture();
    try {
      f.terminal.resize(111, 37);
      await f.run("resize");
      await until(() => f.output().includes("SIZE:111x37"));
    } finally {
      await f.close();
    }
  },
  45_000,
);
windowsIt(
  "Ctrl-C interrupts a foreground program and leaves cmd usable",
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
windowsIt(
  "empties the Job Object including a detached child before resolving",
  async () => {
    const f = await nativePtyFixture();
    try {
      await f.run("tree");
      await until(async () => !!(await f.read("tree.json")) && !!(await f.read("detached.ready")));
      const children: number[] = JSON.parse(await f.read("tree.json"));
      expect(await spawnedProcessAlive(children[1]!)).toBe(true);
      await f.terminal.killTree();
      for (const pid of [f.pid, ...children]) expect(await spawnedProcessAlive(pid)).toBe(false);
    } finally {
      await f.close();
    }
  },
  45_000,
);
