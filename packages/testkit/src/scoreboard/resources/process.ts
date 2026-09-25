import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { ProcessReading, ResourceInventory } from "./contracts.js";
import { measured, unavailable } from "./contracts.js";

const execute = promisify(execFile);
export interface ProcessTarget {
  pid: number;
  identity: ResourceInventory["processes"][number];
}

export function parseCpuTime(value: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim());
  if (!match) throw new Error("Invalid process CPU counter");
  const [, days, hours, minutes, seconds] = match;
  return (
    (Number(days ?? 0) * 86400 +
      Number(hours ?? 0) * 3600 +
      Number(minutes) * 60 +
      Number(seconds)) *
    1000
  );
}

/** Read only explicitly owned PIDs. No process discovery, command lines, or credentials. */
export function createProcessSampler(
  targets: readonly ProcessTarget[],
  platform = process.platform,
) {
  if (new Set(targets.map((target) => target.pid)).size !== targets.length)
    throw new Error("A physical process cannot be counted through multiple aliases");
  if (
    new Set(targets.map((target) => target.identity.domain)).size > 1 ||
    targets.some((target) => target.identity.coveredBy !== null)
  )
    throw new Error("Guest processes require a guest-side sampler");
  for (const target of targets)
    if (!Number.isSafeInteger(target.pid) || target.pid < 1) throw new Error("Invalid process PID");
  const lifetimes = new Map<string, string>();
  return async (signal?: AbortSignal): Promise<ProcessReading[]> =>
    Promise.all(
      targets.map(async ({ pid, identity }) => {
        const empty: ProcessReading = {
          ...identity,
          memoryMetric: platform === "win32" ? "private-bytes" : "rss",
          memoryBytes: unavailable(),
          highWaterBytes: unavailable(),
          cpuTimeMs: unavailable(),
          wakeups: unavailable("unsupported"),
          diskWriteBytes: unavailable("unsupported"),
          networkBytes: unavailable("unsupported"),
        };
        try {
          let lifetime: string;
          if (platform === "win32") {
            const { stdout } = await execute(
              "powershell.exe",
              [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                `$p=Get-Process -Id ${pid} -ErrorAction Stop; [PSCustomObject]@{start=$p.StartTime.ToUniversalTime().Ticks; memory=$p.PrivateMemorySize64; cpu=$p.TotalProcessorTime.TotalMilliseconds} | ConvertTo-Json -Compress`,
              ],
              { signal, timeout: 5000, maxBuffer: 4096 },
            );
            const data = JSON.parse(stdout) as { start: number; memory: number; cpu: number };
            lifetime = String(data.start);
            empty.memoryBytes = measured(data.memory);
            empty.cpuTimeMs = measured(data.cpu);
          } else if (platform === "darwin" || platform === "linux") {
            const { stdout } = await execute(
              "ps",
              ["-p", String(pid), "-o", "lstart=", "-o", "rss=", "-o", "time="],
              { signal, timeout: 5000, maxBuffer: 4096, env: { ...process.env, LC_ALL: "C" } },
            );
            const match = /^\s*(.+?)\s+(\d+)\s+([\d:.-]+)\s*$/.exec(stdout);
            if (!match) throw new Error("Process disappeared");
            lifetime = match[1]!;
            empty.memoryBytes = measured(Number(match[2]) * 1024);
            empty.cpuTimeMs = measured(parseCpuTime(match[3]!));
            if (platform === "linux") {
              const status = await readFile(`/proc/${pid}/status`, "utf8");
              const high = /^VmHWM:\s+(\d+) kB$/m.exec(status);
              if (high) empty.highWaterBytes = measured(Number(high[1]) * 1024);
              const io = await readFile(`/proc/${pid}/io`, "utf8").catch(() => "");
              const writes = /^write_bytes:\s+(\d+)$/m.exec(io);
              if (writes) empty.diskWriteBytes = measured(Number(writes[1]));
            }
          } else return empty;
          const previous = lifetimes.get(identity.id);
          if (previous !== undefined && previous !== lifetime) throw new Error("PID reused");
          lifetimes.set(identity.id, lifetime);
          return empty;
        } catch {
          return {
            ...empty,
            memoryBytes: unavailable("invalid-trial"),
            highWaterBytes: unavailable("invalid-trial"),
            cpuTimeMs: unavailable("invalid-trial"),
            diskWriteBytes: unavailable("invalid-trial"),
          };
        }
      }),
    );
}
