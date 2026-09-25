import { performance } from "node:perf_hooks";
import type { MetricEvidence, PerformanceEvidenceReport } from "../../performance-report.js";
import { createPerformanceEvidenceEnvelope } from "../../performance-report.js";
import { contentDigest, METRIC_DEFINITIONS } from "../manifest.js";
import { writeImmutableReport } from "../packaged/runner.js";
import type { ResourceInventory } from "./contracts.js";
import {
  attributeResources,
  digest,
  exactKeys,
  measured,
  opaque,
  unavailable,
  validateInventory,
} from "./contracts.js";
import type { ProcessTarget } from "./process.js";
import { createProcessSampler } from "./process.js";
import type { ResourceProfile, SampleAttempt } from "./profiles.js";
import { collectResourceProfile } from "./profiles.js";

export interface ResourceBinding {
  artifactHash: string;
  environmentHash: string;
  sessionId: string;
  pairId: string;
  target: string;
}

export async function captureStackResources(options: {
  binding: ResourceBinding;
  inventory: ResourceInventory;
  processes: ProcessTarget[];
  profile: ResourceProfile;
  output: string;
  signal: AbortSignal;
  mixedWork?: (signal: AbortSignal) => Promise<void>;
}) {
  exactKeys(options.binding, ["artifactHash", "environmentHash", "sessionId", "pairId", "target"]);
  digest(options.binding.artifactHash);
  digest(options.binding.environmentHash);
  opaque(options.binding.sessionId);
  opaque(options.binding.pairId);
  opaque(options.binding.target);
  validateInventory(options.inventory);
  if (
    options.processes.some(
      (p) =>
        !options.inventory.processes.some((i) => contentDigest(i) === contentDigest(p.identity)),
    )
  )
    throw new Error("Sampler process is outside declared inventory");
  const sample = createProcessSampler(options.processes);
  const attempts: SampleAttempt[] = [];
  const references: Awaited<ReturnType<typeof writeImmutableReport>>[] = [];
  const start = performance.now();
  const summary = await collectResourceProfile({
    profile: options.profile,
    signal: options.signal,
    mixedWork: options.mixedWork,
    sample: async (signal) => ({
      atMs: performance.now() - start,
      processes: await sample(signal),
    }),
    onAttempt: async (attempt) => {
      attempts.push(attempt);
      // Stream raw frames to immutable files; an interrupted run retains earlier attempts.
      references.push(
        await writeImmutableReport(options.output, { binding: options.binding, ...attempt }),
      );
    },
  });
  const value = {
    version: 1,
    binding: options.binding,
    inventory: options.inventory,
    summary,
    frames: references,
    coverage: summarizeResourceAttempts(options.inventory, attempts, summary.complete),
  };
  return { ...value, artifact: await writeImmutableReport(options.output, value) };
}

export function summarizeResourceAttempts(
  inventory: ResourceInventory,
  attempts: SampleAttempt[],
  windowComplete: boolean,
) {
  const valid = attempts.flatMap((a) => (a.status === "measured" && a.frame ? [a.frame] : []));
  const totals = valid.map((frame) => attributeResources(inventory, frame));
  const complete =
    windowComplete &&
    attempts.length > 1 &&
    valid.length === attempts.length &&
    totals.every((t) => t.memoryBytes.value !== null);
  const values = totals.map((t) => t.memoryBytes.value);
  const accounting = new Set(totals.map((t) => t.memoryMetric));
  const usable = complete && accounting.size === 1;
  const first = valid[0],
    last = valid.at(-1);
  let cpu = 0,
    cpuComplete = usable;
  for (const item of inventory.processes.filter((p) => p.coveredBy === null)) {
    let previous = -1;
    for (const frame of valid) {
      const value = frame.processes.find((p) => p.id === item.id)?.cpuTimeMs.value;
      if (value === null || value === undefined || value < previous) cpuComplete = false;
      else previous = value;
    }
    const before = first?.processes.find((p) => p.id === item.id)?.cpuTimeMs.value;
    const after = last?.processes.find((p) => p.id === item.id)?.cpuTimeMs.value;
    if (
      before === null ||
      before === undefined ||
      after === null ||
      after === undefined ||
      after < before
    )
      cpuComplete = false;
    else cpu += after - before;
  }
  return {
    complete: usable,
    memoryMetric: accounting.size === 1 ? (totals[0]?.memoryMetric ?? null) : null,
    idleMeanBytes: usable
      ? measured(values.reduce<number>((sum, value) => sum + value!, 0) / values.length)
      : unavailable(),
    peakBytes: usable ? measured(Math.max(...(values as number[]))) : unavailable(),
    cpuTimeMs: cpuComplete ? measured(cpu) : unavailable(),
    highWaterBytes: unavailable(),
    energyJoules: unavailable(),
    wholeMachineIncremental: unavailable(),
    sharedPagesMayOverlap: totals.some((t) => t.sharedPagesMayOverlap),
  };
}

export function attachResourceMetrics(
  report: PerformanceEvidenceReport,
  collected: Awaited<ReturnType<typeof captureStackResources>>,
) {
  if (
    report.scenario.tier !== "T2" ||
    report.build.artifactHash !== collected.binding.artifactHash ||
    report.environmentHash !== collected.binding.environmentHash ||
    (collected.coverage.memoryMetric !== null &&
      report.environment.memoryAccounting !== collected.coverage.memoryMetric)
  )
    throw new Error("Resource evidence binding or accounting mismatch");
  const traceId = `resources-${collected.artifact.sha256.slice(0, 24)}`;
  const values = {
    "m10.idle-footprint":
      collected.summary.profile === "mixed-soak"
        ? unavailable("not-applicable")
        : collected.coverage.idleMeanBytes,
    "m10.peak-footprint": collected.coverage.peakBytes,
    "m14.idle-cpu-time":
      collected.summary.profile === "mixed-soak"
        ? unavailable("not-applicable")
        : collected.coverage.cpuTimeMs,
  };
  const fragments = new Map(
    Object.entries(values).map(([id, reading]): [string, MetricEvidence] => {
      const definition = METRIC_DEFINITIONS.find((m) => m.id === id)!;
      return [
        id,
        {
          id,
          unit: definition.unit,
          direction: definition.direction,
          applicability: "applicable",
          missingReason: reading.missingReason,
          coverage: { expected: 1, observed: reading.value === null ? 0 : 1 },
          observations: [
            {
              ...reading,
              id: `observation-${id}`,
              sessionId: collected.binding.sessionId,
              pairId: collected.binding.pairId,
              traceId,
              outcome: collected.summary.complete ? "success" : "failed",
              provenance:
                reading.value === null
                  ? null
                  : { kind: "measured", sourceHash: collected.artifact.sha256 },
            },
          ],
        },
      ];
    }),
  );
  if (report.metrics.some((m) => fragments.has(m.id) && m.observations.length))
    throw new Error("Cannot overwrite resource attempts");
  return createPerformanceEvidenceEnvelope({
    ...report,
    artifacts: [
      ...report.artifacts,
      { sha256: collected.artifact.sha256, bytes: collected.artifact.bytes, kind: "trace" },
    ],
    traces: [
      ...report.traces,
      { id: traceId, artifactHash: collected.artifact.sha256, clock: "monotonic" },
    ],
    metrics: report.metrics.map((m) => fragments.get(m.id) ?? m),
  });
}
