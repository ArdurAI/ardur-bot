import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { GuardedHostTerminalFactory } from "@ardurbot/host-runtime/host-terminal";
import type { ProcessIdentity, PtyModule, TreeOperations } from "./host-terminal-pty.js";
import { trackedPosixTerminal } from "./host-terminal-pty.js";

/** /proc stat comm may contain spaces and parentheses. Field 22 is the start tick. */
export function parseLinuxProcessStat(stat: string): ProcessIdentity {
  const end = stat.lastIndexOf(") ");
  const pid = Number(stat.slice(0, stat.indexOf(" (")));
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  const session = Number(fields[3]);
  if (
    end < 0 ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    ![parent, group, session].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !/^[A-Za-z]$/.test(fields[0] ?? "") ||
    !/^\d+$/.test(fields[19] ?? "")
  )
    throw new Error("Invalid terminal process lookup.");
  return { pid, parent, group, session, birth: fields[19]!, zombie: fields[0] === "Z" };
}

/** Metadata only, with bounded concurrency; unreadable entries are never proof of death. */
export async function linuxProcessSnapshot(timeoutMs: number, procRoot = "/proc") {
  const deadline = Date.now() + timeoutMs;
  const entries = (await readdir(procRoot)).filter((entry) => /^\d+$/.test(entry));
  if (entries.length > 65536) throw new Error("Terminal process lookup exceeds limit.");
  const rows: ProcessIdentity[] = [];
  for (let offset = 0; offset < entries.length; offset += 32) {
    if (Date.now() >= deadline) throw new Error("Terminal process lookup timed out.");
    const batch = await Promise.all(
      entries.slice(offset, offset + 32).map(async (entry) => {
        try {
          const row = parseLinuxProcessStat(
            await readFile(path.join(procRoot, entry, "stat"), "utf8"),
          );
          if (row.pid !== Number(entry)) throw new Error("Invalid terminal process lookup.");
          return row;
        } catch (error) {
          if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
          throw new Error("Terminal process lookup failed.");
        }
      }),
    );
    for (const row of batch) if (row) rows.push(row);
  }
  return rows;
}

const linuxTree: TreeOperations = {
  snapshot: linuxProcessSnapshot,
  requireSessionLeader: true,
  signal(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
};

/** Conformance only until OS process guards and installed acceptance allow admission. */
export function linuxHostTerminalFactory(
  pty: PtyModule,
  operations: TreeOperations = linuxTree,
): GuardedHostTerminalFactory {
  return () => ({
    async spawn(shell, cwd, env, cols, rows) {
      // node-pty's Unix fork calls setsid before exec: the shell leads its session.
      const child = pty.spawn(shell, ["-l"], {
        cwd,
        env: { ...env },
        cols,
        rows,
        name: "xterm-256color",
        encoding: null,
      });
      return trackedPosixTerminal(child, operations);
    },
  });
}
