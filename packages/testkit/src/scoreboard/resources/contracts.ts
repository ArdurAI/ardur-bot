import type { MissingReason } from "../../performance-report.js";
import { MISSING_REASONS } from "../../performance-report.js";

export const RESOURCE_ROLES = [
  "electron",
  "host",
  "api",
  "worker",
  "database",
  "vm",
  "local-model",
] as const;
export type ResourceRole = (typeof RESOURCE_ROLES)[number];
export type MemoryMetric = "rss" | "pss" | "private-bytes" | "working-set";

export interface Reading {
  value: number | null;
  missingReason: MissingReason | null;
}
export const unavailable = (missingReason: MissingReason = "not-measured"): Reading => ({
  value: null,
  missingReason,
});
export function measured(value: number): Reading {
  finite(value);
  return { value, missingReason: null };
}
export function finite(value: number) {
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid nonnegative measurement");
}
export function digest(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid content digest");
}
export function opaque(value: string) {
  if (!/^[a-zA-Z0-9_:-]{1,128}$/.test(value)) throw new Error("Invalid opaque identifier");
}
export function exactKeys(value: object, allowed: readonly string[]) {
  if (Object.keys(value).sort().join(",") !== [...allowed].sort().join(","))
    throw new Error("Unexpected measurement fields");
}

/** One identity is one process lifetime, even when API and worker share that process. */
export interface ProcessReading {
  id: string;
  roles: ResourceRole[];
  domain: string;
  coveredBy: string | null;
  memoryMetric: MemoryMetric;
  memoryBytes: Reading;
  highWaterBytes: Reading;
  cpuTimeMs: Reading;
  wakeups: Reading;
  diskWriteBytes: Reading;
  networkBytes: Reading;
}
export interface ResourceFrame {
  atMs: number;
  processes: ProcessReading[];
}
export interface ResourceInventory {
  roles: Record<ResourceRole, "required" | "not-applicable">;
  // Identities are local labels. Raw command lines and environment variables are never exported.
  processes: { id: string; roles: ResourceRole[]; domain: string; coveredBy: string | null }[];
}

export function validateInventory(inventory: ResourceInventory) {
  exactKeys(inventory, ["roles", "processes"]);
  exactKeys(inventory.roles, RESOURCE_ROLES);
  const ids = new Map(inventory.processes.map((item) => [item.id, item]));
  if (ids.size !== inventory.processes.length) throw new Error("Duplicate process identity");
  for (const item of inventory.processes) {
    exactKeys(item, ["id", "roles", "domain", "coveredBy"]);
    opaque(item.id);
    opaque(item.domain);
    if (
      !item.roles.length ||
      new Set(item.roles).size !== item.roles.length ||
      item.roles.some((role) => !RESOURCE_ROLES.includes(role))
    )
      throw new Error("Invalid process roles");
    const seen = new Set([item.id]);
    let parent = item.coveredBy;
    if (parent !== null && ids.get(parent)?.domain === item.domain)
      throw new Error("Guest and VM accounting domains must differ");
    while (parent !== null) {
      if (seen.has(parent)) throw new Error("Cyclic process accounting");
      seen.add(parent);
      const entry = ids.get(parent);
      if (!entry?.roles.includes("vm")) throw new Error("Missing VM accounting boundary");
      parent = entry.coveredBy;
    }
  }
  for (const role of RESOURCE_ROLES) {
    if (!["required", "not-applicable"].includes(inventory.roles[role]))
      throw new Error("Invalid role coverage");
    if (
      inventory.roles[role] === "not-applicable" &&
      inventory.processes.some((p) => p.roles.includes(role))
    )
      throw new Error("Observed role cannot be not applicable");
  }
}

/** Per-platform totals are descriptive sums, not interchangeable physical-memory estimates. */
export function attributeResources(inventory: ResourceInventory, frame: ResourceFrame) {
  validateInventory(inventory);
  exactKeys(frame, ["atMs", "processes"]);
  finite(frame.atMs);
  const observed = new Map<string, ProcessReading>();
  for (const item of frame.processes) {
    exactKeys(item, [
      "id",
      "roles",
      "domain",
      "coveredBy",
      "memoryMetric",
      "memoryBytes",
      "highWaterBytes",
      "cpuTimeMs",
      "wakeups",
      "diskWriteBytes",
      "networkBytes",
    ]);
    const declared = inventory.processes.find((entry) => entry.id === item.id);
    if (
      !declared ||
      observed.has(item.id) ||
      item.domain !== declared.domain ||
      item.coveredBy !== declared.coveredBy ||
      [...item.roles].sort().join() !== [...declared.roles].sort().join()
    )
      throw new Error("Undeclared, duplicate or changed process identity");
    if (!["rss", "pss", "private-bytes", "working-set"].includes(item.memoryMetric))
      throw new Error("Unknown platform memory metric");
    for (const value of [
      item.memoryBytes,
      item.highWaterBytes,
      item.cpuTimeMs,
      item.wakeups,
      item.diskWriteBytes,
      item.networkBytes,
    ]) {
      exactKeys(value, ["value", "missingReason"]);
      if (value.value === null) {
        if (!value.missingReason || !MISSING_REASONS.includes(value.missingReason))
          throw new Error("Missing reading needs a valid reason");
      } else {
        finite(value.value);
        if (value.missingReason !== null) throw new Error("Measured reading cannot be missing");
      }
    }
    observed.set(item.id, item);
  }
  const missingRoles = RESOURCE_ROLES.filter(
    (role) =>
      inventory.roles[role] === "required" &&
      !inventory.processes.some(
        (p) =>
          p.roles.includes(role) &&
          observed.get(p.id)?.memoryBytes.value !== null &&
          observed.has(p.id),
      ),
  );
  const missingProcesses = inventory.processes.filter((p) => !observed.has(p.id)).map((p) => p.id);
  const selected = frame.processes.filter((p) => p.coveredBy === null);
  const metrics = new Set(selected.map((p) => p.memoryMetric));
  const complete =
    !missingRoles.length &&
    !missingProcesses.length &&
    selected.length > 0 &&
    selected.every((p) => p.memoryBytes.value !== null) &&
    metrics.size === 1;
  return {
    missingRoles,
    missingProcesses,
    excludedGuests: frame.processes.filter((p) => p.coveredBy !== null).map((p) => p.id),
    memoryMetric: metrics.size === 1 ? selected[0]!.memoryMetric : null,
    memoryBytes: complete
      ? measured(selected.reduce((sum, p) => sum + p.memoryBytes.value!, 0))
      : unavailable("not-measured"),
    sharedPagesMayOverlap: selected.some(
      (p) => p.memoryMetric === "rss" || p.memoryMetric === "working-set",
    ),
    // Whole-machine incremental footprint needs a separate matched idle control; this is never that metric.
    wholeMachineIncremental: unavailable(),
  };
}
