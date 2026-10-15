import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import { expect, it, vi } from "vitest";
import {
  linuxHostTerminalFactory,
  linuxProcessSnapshot,
  parseLinuxProcessStat,
} from "./host-terminal-pty-linux.js";

function stat(pid = 100, comm = "shell (with) spaces", state = "S", birth = "1234567890123") {
  return `${pid} (${comm}) ${[state, "1", `${pid}`, `${pid}`, ...Array(15).fill("0"), birth, "0"].join(" ")}\n`;
}
it("parses numeric ancestry, session and exact birth ticks despite spaces and parentheses", () => {
  expect(parseLinuxProcessStat(stat())).toEqual({
    pid: 100,
    parent: 1,
    group: 100,
    session: 100,
    birth: "1234567890123",
    zombie: false,
  });
  expect(parseLinuxProcessStat(stat(101, "a)b (c", "Z")).zombie).toBe(true);
});
it.each(["", "100 (shell) S 1 100", stat(0), stat(100, "shell", "S", "bad")])(
  "refuses malformed stat metadata: %s",
  (value) => {
    expect(() => parseLinuxProcessStat(value)).toThrow("Invalid terminal process lookup");
  },
);
it("reads only stat metadata, ignores vanished entries and refuses malformed or mismatched entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "host-proc-fixture-"));
  try {
    for (const name of ["100", "101", "self"]) await mkdir(path.join(root, name));
    await writeFile(path.join(root, "100/stat"), stat());
    await writeFile(path.join(root, "self/stat"), "never read");
    expect(await linuxProcessSnapshot(2000, root)).toEqual([parseLinuxProcessStat(stat())]);
    await writeFile(path.join(root, "101/stat"), "malformed");
    await expect(linuxProcessSnapshot(2000, root)).rejects.toThrow("lookup failed");
    await writeFile(path.join(root, "101/stat"), stat(102));
    await expect(linuxProcessSnapshot(2000, root)).rejects.toThrow("lookup failed");
    await expect(linuxProcessSnapshot(0, root)).rejects.toThrow("timed out");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("refuses a shell that did not become a session leader and kills only its PTY", async () => {
  const child = { pid: 100, pause: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
  const operations = {
    requireSessionLeader: true,
    snapshot: vi.fn(async () => [{ ...parseLinuxProcessStat(stat()), session: 99 }]),
    signal: vi.fn(),
  };
  const factory = linuxHostTerminalFactory({ spawn: () => child as unknown as IPty }, operations);
  await expect(
    factory({ paths: [], ports: [], sockets: [] }).spawn("/bin/sh", "/fixture", {}, 80, 24),
  ).rejects.toThrow("not a session leader");
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  expect(operations.signal).not.toHaveBeenCalled();
});

it("tracks reparented members of the original session without adopting another session", async () => {
  vi.useFakeTimers();
  const root = parseLinuxProcessStat(stat());
  const member = { ...root, pid: 101, parent: 1, group: 101, birth: "child" };
  const foreign = { ...root, pid: 900, parent: 1, group: 900, session: 900, birth: "foreign" };
  let rows = [root];
  const operations = {
    requireSessionLeader: true,
    snapshot: vi.fn(async () => rows),
    signal: vi.fn(),
  };
  const child = { pid: 100, pause: vi.fn(), onExit: vi.fn(), kill: vi.fn() };
  const terminal = await linuxHostTerminalFactory(
    { spawn: () => child as unknown as IPty },
    operations,
  )({ paths: [], ports: [], sockets: [] }).spawn("/bin/sh", "/fixture", {}, 80, 24);
  try {
    rows = [root, member, foreign];
    const cleanup = terminal.killTree();
    await vi.advanceTimersByTimeAsync(0);
    expect(operations.signal.mock.calls).toEqual([
      [-100, "SIGTERM"],
      [101, "SIGTERM"],
    ]);
    rows = [foreign];
    await vi.advanceTimersByTimeAsync(100);
    await cleanup;
    expect(operations.signal.mock.calls.some(([pid]) => pid === 900 || pid === -900)).toBe(false);
  } finally {
    rows = [];
    await terminal.killTree();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
