import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import type { HostGuardrailConfig } from "@ardurbot/host-runtime/host-guardrails";
import {
  resolveGuardrailPaths,
  SEATBELT_BINARY,
  seatbeltProfile,
} from "@ardurbot/host-runtime/host-guardrails";
import type {
  GuardedHostTerminalFactory,
  HostTerminalProcess,
} from "@ardurbot/host-runtime/host-terminal";
import { TERMINAL_CLEANUP_DEADLINE_MS } from "@ardurbot/host-runtime/terminal-cleanup";
import type { IPty, IPtyForkOptions } from "node-pty";

export interface PtyModule {
  spawn(file: string, args: string[], options: IPtyForkOptions): IPty;
}

/** Never load a native addon on the platforms whose terminal support is still pending. */
export function loadDarwinPty(
  bundleFile = typeof __filename === "string" && __filename.endsWith(".cjs")
    ? __filename
    : undefined,
): PtyModule | undefined {
  if (process.platform !== "darwin") return undefined;
  if (process.arch !== "arm64" && process.arch !== "x64") return undefined;
  const require = createRequire(bundleFile ?? import.meta.url);
  return require(
    bundleFile
      ? path.join(path.dirname(bundleFile), "native", `mac_${process.arch}`, "node-pty")
      : "node-pty",
  ) as PtyModule;
}

export type ProcessIdentity = {
  pid: number;
  parent: number;
  group: number;
  birth: string;
  zombie: boolean;
};
export interface TreeOperations {
  snapshot(timeoutMs: number): Promise<ProcessIdentity[]>;
  signal(pid: number, signal: "SIGTERM" | "SIGKILL"): void;
}

/** Metadata only: no command arguments or environments are read or logged. */
export function darwinProcessSnapshot(timeoutMs: number): Promise<ProcessIdentity[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/ps",
      ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
      {
        timeout: Math.max(1, timeoutMs),
        maxBuffer: 2 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      },
      (error, stdout) => {
        if (error) return reject(new Error("Terminal process lookup failed."));
        const rows: ProcessIdentity[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
          if (!match) return reject(new Error("Invalid terminal process lookup."));
          rows.push({
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            zombie: match[4]!.startsWith("Z"),
            birth: match[5]!,
          });
        }
        resolve(rows);
      },
    );
  });
}

const systemTree: TreeOperations = {
  snapshot: darwinProcessSnapshot,
  signal: (pid, signal) => {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  },
};
// At most two background listings per second, shared across all open terminals.
// Schedule after completion so slow lookups cannot pile up under load.
const POLL_MS = 500;
const LOOKUP_TIMEOUT_MS = 2000;
const CLEANUP_RETRY_MS = 100;
const TERM_GRACE_MS = 1500;
// Finish before the provider's outer deadline so rejection retains the closing session.
const TREE_DEADLINE_MS = TERMINAL_CLEANUP_DEADLINE_MS - 500;

async function processSnapshot(operations: TreeOperations, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operations.snapshot(timeoutMs),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Terminal process lookup timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class DarwinPoller {
  private readonly trees = new Set<DarwinTree>();
  private timer?: ReturnType<typeof setTimeout>;
  private polling = false;
  constructor(private readonly operations: TreeOperations) {}
  add(tree: DarwinTree) {
    this.trees.add(tree);
    this.poll();
  }
  remove(tree: DarwinTree) {
    this.trees.delete(tree);
    if (!this.trees.size) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  private poll() {
    if (!this.trees.size || this.timer || this.polling) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.polling = true;
      void processSnapshot(this.operations, LOOKUP_TIMEOUT_MS)
        .then((rows) => {
          for (const tree of this.trees) {
            try {
              tree.observe(rows);
            } catch {
              // A tracker failure must not prevent observation of other terminals.
            }
          }
        })
        // A background observation gap is not evidence that cleanup failed.
        // Termination always makes fresh, deadline-bound lookups.
        .catch(() => {})
        .finally(() => {
          this.polling = false;
          this.poll();
        });
    }, POLL_MS);
    this.timer.unref();
  }
}

const pollers = new WeakMap<TreeOperations, DarwinPoller>();
function sharedPoller(operations: TreeOperations) {
  let poller = pollers.get(operations);
  if (!poller) {
    poller = new DarwinPoller(operations);
    pollers.set(operations, poller);
  }
  return poller;
}

/** Tracks descendants while their parent links still exist, including across shell exit. */
class DarwinTree {
  private readonly owned = new Map<number, string>();
  private rootSeen = false;
  private cleanup?: Promise<void>;
  constructor(
    private readonly root: number,
    private readonly operations: TreeOperations,
    private readonly poller: DarwinPoller,
  ) {
    if (!Number.isSafeInteger(root) || root <= 1) throw new Error("Invalid terminal PID.");
  }
  async start() {
    // A background snapshot may have started before this shell was spawned.
    this.observe(await processSnapshot(this.operations, LOOKUP_TIMEOUT_MS));
    // A shell that already exited must not be adopted later through PID reuse.
    this.rootSeen = true;
    this.poller.add(this);
  }
  observe(rows: ProcessIdentity[]) {
    const root = rows.find((row) => row.pid === this.root);
    if (!this.rootSeen && root) {
      this.rootSeen = true;
      this.owned.set(root.pid, root.birth);
    }
    // Only live, same-identity ancestors can establish new ownership. A reused PID
    // must never turn its new children into terminal descendants.
    const live = new Set(
      rows.filter((row) => this.owned.get(row.pid) === row.birth).map((r) => r.pid),
    );
    let added = true;
    while (added) {
      added = false;
      for (const row of rows) {
        if (row.pid <= 1 || live.has(row.pid) || !live.has(row.parent)) continue;
        if (this.owned.has(row.pid) && this.owned.get(row.pid) !== row.birth) continue;
        if (this.owned.size >= 4096)
          throw new Error("Terminal process tree exceeds tracking limit.");
        this.owned.set(row.pid, row.birth);
        live.add(row.pid);
        added = true;
      }
    }
    // A descendant that calls setsid and reparents between observations can escape.
    // Step 3 must close this gap before terminal capability admission is enabled.
  }
  killTree() {
    if (this.cleanup) return this.cleanup;
    this.poller.remove(this);
    this.cleanup = this.terminate().catch((error) => {
      this.cleanup = undefined;
      throw error;
    });
    return this.cleanup;
  }
  private async terminate() {
    const started = Date.now();
    let termSent = false;
    const termed = new Set<number>();
    for (;;) {
      const remaining = TREE_DEADLINE_MS - (Date.now() - started);
      if (remaining <= 0) throw new Error("Terminal process tree is still closing.");
      let rows: ProcessIdentity[];
      try {
        // Do not reuse a background lookup started before termination.
        rows = await processSnapshot(this.operations, Math.min(LOOKUP_TIMEOUT_MS, remaining));
        this.observe(rows);
      } catch {
        const retryRemaining = TREE_DEADLINE_MS - (Date.now() - started);
        if (retryRemaining > 0)
          await new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(CLEANUP_RETRY_MS, retryRemaining)),
          );
        continue;
      }
      if (Date.now() - started >= TREE_DEADLINE_MS)
        throw new Error("Terminal process tree is still closing.");
      const live = rows.filter((row) => this.owned.get(row.pid) === row.birth && !row.zombie);
      const group = rows.filter((row) => row.group === this.root && !row.zombie);
      if (!live.length && !group.length) return;
      const signal = Date.now() - started >= TERM_GRACE_MS ? "SIGKILL" : "SIGTERM";
      if (!termSent || signal === "SIGKILL") {
        // The PTY creates a new session/group. Signal it only if every member is
        // a proven descendant. Then also signal tracked children that left it.
        const safeGroup =
          group.length > 0 && group.every((row) => this.owned.get(row.pid) === row.birth);
        if (safeGroup) this.operations.signal(-this.root, signal);
        for (const row of live) {
          if (row.group !== this.root || !safeGroup) this.operations.signal(row.pid, signal);
          termed.add(row.pid);
        }
        termSent = true;
      } else {
        // A child born during TERM grace needs its own TERM before escalation.
        for (const row of live)
          if (!termed.has(row.pid)) {
            this.operations.signal(row.pid, "SIGTERM");
            termed.add(row.pid);
          }
      }
      const retryRemaining = TREE_DEADLINE_MS - (Date.now() - started);
      if (retryRemaining > 0)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(CLEANUP_RETRY_MS, retryRemaining)),
        );
    }
  }
}

/** The composition root may inject this factory only after platform admission is enabled. */
export function darwinHostTerminalFactory(
  pty: PtyModule,
  operations: TreeOperations = systemTree,
): GuardedHostTerminalFactory {
  return (guard: HostGuardrailConfig) => ({
    async spawn(shell, cwd, env, cols, rows): Promise<HostTerminalProcess> {
      const profile = seatbeltProfile({
        paths: await resolveGuardrailPaths(guard.paths),
        ports: guard.ports,
        sockets: await resolveGuardrailPaths(guard.sockets),
      });
      const child = pty.spawn(SEATBELT_BINARY, ["-p", profile, shell, "-l"], {
        cwd,
        env: { ...env },
        cols,
        rows,
        name: "xterm-256color",
        encoding: null,
      });
      // Keep the initial prompt in the PTY stream until the provider subscribes.
      child.pause();
      const tree = new DarwinTree(child.pid, operations, sharedPoller(operations));
      // Register before the first asynchronous lookup so a quick exit isn't lost.
      let exited = false;
      const exits = new Set<() => void>();
      child.onExit(() => {
        exited = true;
        for (const listener of exits) listener();
      });
      try {
        await tree.start();
      } catch (error) {
        // The spawned shell is ours, but without ancestry evidence we cannot
        // claim tree cleanup. Keep the failure visible to admission.
        if (!exited) {
          try {
            child.kill("SIGKILL");
          } catch (killError) {
            if ((killError as NodeJS.ErrnoException).code !== "ESRCH") throw killError;
          }
        }
        throw error;
      }
      let closing = false;
      return {
        write(bytes) {
          if (closing || exited) throw new Error("Terminal process is closing.");
          child.write(Buffer.from(bytes));
        },
        resize(columns, lines) {
          if (closing || exited) throw new Error("Terminal process is closing.");
          child.resize(columns, lines);
        },
        onData(listener) {
          const subscription = child.onData((data) => listener(Buffer.from(data)));
          child.resume();
          return () => subscription.dispose();
        },
        onExit(listener) {
          exits.add(listener);
          if (exited) listener();
          return () => exits.delete(listener);
        },
        killTree() {
          closing = true;
          return tree.killTree();
        },
      };
    },
  });
}

export function macOSHostTerminalFactory(): GuardedHostTerminalFactory | undefined {
  const pty = loadDarwinPty();
  return pty ? darwinHostTerminalFactory(pty) : undefined;
}
