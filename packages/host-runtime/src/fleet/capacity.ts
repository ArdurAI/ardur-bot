import { statfs } from "node:fs/promises";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import type { CapacitySnapshot } from "@ardurbot/contracts";
import { CapacitySnapshotSchema, unknownCapacity } from "@ardurbot/contracts/fleet";

export function cachedCapacity(sample: () => Promise<CapacitySnapshot>, now = Date.now) {
  let value: Promise<CapacitySnapshot> | undefined;
  let expires = 0;
  return () => {
    if (!value || now() >= expires) {
      expires = now() + 30_000;
      let timer: ReturnType<typeof setTimeout>;
      value = Promise.race([
        sample(),
        new Promise<CapacitySnapshot>((resolve) => {
          timer = setTimeout(() => resolve(unknownCapacity()), 10_000);
        }),
      ])
        .then((snapshot) => CapacitySnapshotSchema.parse(snapshot))
        .catch(() => unknownCapacity())
        .finally(() => clearTimeout(timer));
    }
    return value;
  };
}
export const hostCapacity = cachedCapacity(async () => {
  const disk = await statfs(homedir()).catch(() => null);
  return {
    cpuCount: cpus().length,
    cpuLoad1m: loadavg()[0] ?? null,
    memoryTotal: totalmem(),
    memoryFree: freemem(),
    diskFree: disk ? disk.bavail * disk.bsize : null,
    sampledAt: new Date().toISOString(),
    source: "host",
  };
});

export const LINUX_CAPACITY_COMMAND = [
  "bash",
  "-c",
  "nproc; cat /proc/loadavg; cat /proc/meminfo; df -Pk .",
];
export function parseLinuxCapacity(output: string): CapacitySnapshot {
  const lines = output.trim().split("\n");
  const total = output.match(/^MemTotal:\s+(\d+)\s+kB$/m);
  const free = output.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
  const disk = lines.at(-1)?.trim().split(/\s+/);
  return CapacitySnapshotSchema.parse({
    cpuCount: Number(lines[0]),
    cpuLoad1m: Number(lines[1]?.split(" ")[0]),
    memoryTotal: total ? Number(total[1]) * 1024 : null,
    memoryFree: free ? Number(free[1]) * 1024 : null,
    diskFree: disk && disk.length >= 6 ? Number(disk[3]) * 1024 : null,
    sampledAt: new Date().toISOString(),
    source: "ssh",
  });
}

export function normalizeEngineInfo(info: Record<string, unknown>): Record<string, unknown> {
  const host = info.host as
    | {
        cpus?: number;
        memTotal?: number;
        memFree?: number;
        os?: string;
        distribution?: { distribution?: string };
        security?: { rootless?: boolean };
      }
    | undefined;
  if (!host) return info;
  return {
    ...info,
    NCPU: host.cpus,
    MemTotal: host.memTotal,
    MemAvailable: host.memFree,
    OSType: host.os,
    OperatingSystem: host.distribution?.distribution ?? host.os,
    ServerVersion: (info.version as { Version?: string } | undefined)?.Version,
    SecurityOptions: host.security?.rootless ? ["rootless"] : [],
  };
}

export function dockerCapacity(
  info: Record<string, unknown>,
  stats?: CapacitySnapshot,
): CapacitySnapshot {
  info = normalizeEngineInfo(info);
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    ...unknownCapacity(),
    source: "docker",
    cpuCount: number(info.NCPU),
    memoryTotal: number(info.MemTotal),
    cpuLoad1m: stats?.cpuLoad1m ?? null,
    memoryFree: stats?.memoryFree ?? number(info.MemAvailable),
    diskFree: stats?.diskFree ?? null,
  };
}
