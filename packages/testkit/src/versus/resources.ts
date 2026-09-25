import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireValue } from "./budget.js";

export interface ProcessSample {
  pid: number;
  parentPid: number;
  rssBytes: number;
  cpuMs: number;
  domain: "host" | "guest";
  vmId: string | null;
  role: "product" | "model" | "vm";
}
export function summarizeResources(samples: ProcessSample[]) {
  const ids = new Set<string>();
  const hostVms = new Set(
    samples
      .filter((sample) => sample.domain === "host" && sample.role === "vm")
      .map((sample) => sample.vmId),
  );
  const product: ProcessSample[] = [];
  const model: ProcessSample[] = [];
  for (const sample of samples) {
    const id = `${sample.domain}:${sample.vmId}:${sample.pid}`;
    requireValue(!ids.has(id), "Duplicate process sample");
    ids.add(id);
    requireValue(
      [sample.rssBytes, sample.cpuMs].every((value) => Number.isFinite(value) && value >= 0),
      "Invalid resource sample",
    );
    if (sample.domain === "guest" && hostVms.has(sample.vmId)) continue;
    (sample.role === "model" ? model : product).push(sample);
  }
  return {
    method: "rss-process-sum-not-physical-memory",
    productRssBytes: product.reduce((sum, sample) => sum + sample.rssBytes, 0),
    productCpuMs: product.reduce((sum, sample) => sum + sample.cpuMs, 0),
    sharedModelRssBytes: model.reduce((sum, sample) => sum + sample.rssBytes, 0),
    physicalBytes: null,
    joules: null,
    energyMissingReason: "not-measured",
  };
}
const exec = promisify(execFile);
export async function sampleProcessTree(rootPids: number[]) {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,rss=,time="], {
    timeout: 2000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const rows = stdout
    .trim()
    .split("\n")
    .map((line): ProcessSample | null => {
      const match =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(line);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        rssBytes: Number(match[3]) * 1024,
        cpuMs:
          (Number(match[4] ?? 0) * 86400 +
            Number(match[5] ?? 0) * 3600 +
            Number(match[6]) * 60 +
            Number(match[7])) *
          1000,
        domain: "host",
        vmId: null,
        role: "product",
      };
    })
    .filter((row): row is ProcessSample => row !== null);
  const ids = new Set(rootPids);
  let size = 0;
  while (size !== ids.size) {
    size = ids.size;
    for (const row of rows) if (ids.has(row.parentPid)) ids.add(row.pid);
  }
  return rows.filter((row) => ids.has(row.pid));
}
