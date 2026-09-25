import type { TraceBatch } from "@ardurbot/contracts";
import type {
  EvidenceOutcome,
  MetricEvidence,
  PerformanceEvidenceReport,
} from "../../performance-report.js";
import { createPerformanceEvidenceEnvelope } from "../../performance-report.js";
import { canonicalSerialize, contentDigest, METRIC_DEFINITIONS } from "../manifest.js";
import { digest, exactKeys, finite, opaque } from "../resources/contracts.js";
import type { TraceCalibration } from "../trace-collector.js";
import {
  CLIENT_TRACE_BOUNDARIES,
  collectTraceEvidence,
  LOCAL_TRACE_BOUNDARIES,
} from "../trace-collector.js";
import type { ClientSurface, PackagedTrial } from "./plan.js";
import { STARTUP_STRATA } from "./plan.js";

export const STARTUP_MILESTONES = [
  "first-window",
  "usable-shell",
  "restored-transcript",
  "working-turn",
] as const;
export interface ClientCapture {
  version: 1;
  client: ClientSurface;
  target: string;
  artifactHash: string;
  environmentHash: string;
  fixtureHash: string;
  trial: PackagedTrial;
  reset: { id: string; profileIsolated: boolean; stateRestored: boolean; cache: string };
  runtime: "ordinary-replay";
  productionBuild: boolean;
  physicalDevice: boolean;
  outcome: EvidenceOutcome;
  // Durations are measured in the runner's single monotonic clock, never wall clock subtraction.
  startup: Record<(typeof STARTUP_MILESTONES)[number], number | null>;
  batches: TraceBatch[];
  calibrations: TraceCalibration[];
}

export function ingestClientCapture(
  capture: ClientCapture,
  expected: {
    client: ClientSurface;
    target: string;
    artifactHash: string;
    environmentHash: string;
    fixtureHash: string;
  },
) {
  exactKeys(capture, [
    "version",
    "client",
    "target",
    "artifactHash",
    "environmentHash",
    "fixtureHash",
    "trial",
    "reset",
    "runtime",
    "productionBuild",
    "physicalDevice",
    "outcome",
    "startup",
    "batches",
    "calibrations",
  ]);
  exactKeys(capture.trial, ["pairId", "sessionId", "build", "stratum", "resetId"]);
  exactKeys(capture.reset, ["id", "profileIsolated", "stateRestored", "cache"]);
  exactKeys(capture.startup, STARTUP_MILESTONES);
  if (
    capture.version !== 1 ||
    !["desktop", "web", "mobile"].includes(capture.client) ||
    capture.client !== expected.client ||
    capture.target !== expected.target ||
    capture.runtime !== "ordinary-replay" ||
    capture.productionBuild !== true ||
    !["parent", "candidate", "fixed-release"].includes(capture.trial.build) ||
    !STARTUP_STRATA.includes(capture.trial.stratum)
  )
    throw new Error("Ineligible packaged client capture");
  if (!["success", "failed", "cancelled", "timed-out", "uncertain"].includes(capture.outcome))
    throw new Error("Invalid trial outcome");
  for (const field of ["artifactHash", "environmentHash", "fixtureHash"] as const) {
    digest(capture[field]);
    if (capture[field] !== expected[field]) throw new Error("Client capture binding mismatch");
  }
  for (const id of [
    capture.target,
    capture.trial.pairId,
    capture.trial.sessionId,
    capture.trial.resetId,
    capture.reset.id,
    capture.reset.cache,
  ])
    opaque(id);
  if (
    capture.reset.id !== capture.trial.resetId ||
    capture.reset.profileIsolated !== true ||
    capture.reset.stateRestored !== true
  )
    throw new Error("Startup requires an independent state/profile reset");
  if (capture.reset.cache !== capture.trial.stratum)
    throw new Error("Startup reset does not match the planned stratum");
  if (capture.client === "mobile" && capture.physicalDevice !== true)
    throw new Error("Mobile acceptance requires a physical device");
  if (typeof capture.physicalDevice !== "boolean") throw new Error("Missing device classification");
  if (!capture.target.startsWith(`${capture.client}-`)) throw new Error("Client target mismatch");
  if (capture.outcome !== "success" && capture.startup["working-turn"] !== null)
    throw new Error("A failed task cannot establish a working turn");
  let previous = 0;
  for (const milestone of STARTUP_MILESTONES) {
    const value = capture.startup[milestone];
    if (value === null) continue;
    finite(value);
    if (value < previous) throw new Error("Reversed startup milestones");
    previous = value;
  }
  // W0-4 owns boundary validation, identity scrubbing, clocks, drops and trace derivation.
  const trace = collectTraceEvidence(capture.batches, {
    sessionId: capture.trial.sessionId,
    pairId: capture.trial.pairId,
    expectedTraces: 1,
    requiredBoundaries: [...LOCAL_TRACE_BOUNDARIES, ...CLIENT_TRACE_BOUNDARIES],
    calibrations: capture.calibrations,
  });
  const terminalOutcome = trace.derived.length === 1 ? trace.derived[0]!.outcome : "uncertain";
  if (
    capture.outcome === "success" &&
    capture.startup["working-turn"] !== null &&
    terminalOutcome !== "success"
  )
    throw new Error("A successful working turn requires a successful terminal trace");
  // Do not export raw runtime IDs. The trace collector's artifact contains scrubbed identities.
  const { batches: _batches, calibrations: _calibrations, ...safe } = capture;
  const raw = canonicalSerialize({ ...safe, traceHash: trace.artifacts[0]!.sha256 });
  const sha256 = contentDigest({ ...safe, traceHash: trace.artifacts[0]!.sha256 });
  const startupMetrics: MetricEvidence[] =
    capture.client !== "desktop"
      ? []
      : STARTUP_MILESTONES.map((milestone) => {
          const definition = METRIC_DEFINITIONS.find((d) => d.id === `m09.${milestone}`)!;
          const value = capture.startup[milestone];
          return {
            id: definition.id,
            unit: definition.unit,
            direction: definition.direction,
            applicability: "applicable",
            missingReason: value === null ? "not-measured" : null,
            coverage: { expected: 1, observed: value === null ? 0 : 1 },
            observations: [
              {
                id: `startup-${milestone}-${capture.trial.resetId}`,
                pairId: capture.trial.pairId,
                sessionId: capture.trial.sessionId,
                traceId: trace.traces[0]?.id ?? `startup-${capture.trial.resetId}`,
                outcome: capture.outcome,
                value,
                missingReason: value === null ? "not-measured" : null,
                provenance: value === null ? null : { kind: "measured", sourceHash: sha256 },
              },
            ],
          };
        });
  return {
    raw,
    sha256,
    bytes: Buffer.byteLength(raw),
    trace,
    startupMetrics,
    complete:
      trace.derived.length === 1 &&
      trace.derived.every((t) => t.complete) &&
      STARTUP_MILESTONES.every((m) => capture.startup[m] !== null),
  };
}

export function ingestWebCapture(
  capture: ClientCapture,
  expected: Omit<Parameters<typeof ingestClientCapture>[1], "client">,
) {
  return ingestClientCapture(capture, { ...expected, client: "web" });
}
export function ingestMobileCapture(
  capture: ClientCapture,
  expected: Omit<Parameters<typeof ingestClientCapture>[1], "client">,
) {
  return ingestClientCapture(capture, { ...expected, client: "mobile" });
}

/** Preserve W0-1's full registry and all unrelated evidence. W0-8 remains the sole budget owner. */
export function attachPackagedCapture(report: PerformanceEvidenceReport, capture: ClientCapture) {
  if (
    report.scenario.tier !== "T2" ||
    report.build.artifactHash !== capture.artifactHash ||
    report.environmentHash !== capture.environmentHash ||
    report.hashes.fixture !== capture.fixtureHash ||
    report.scenario.cacheState !== capture.reset.cache
  )
    throw new Error("Packaged report binding mismatch");
  const collected = ingestClientCapture(capture, capture);
  const fragments = [...collected.trace.metrics, ...collected.startupMetrics];
  const replacements = new Map(fragments.map((m) => [m.id, m]));
  if (report.metrics.some((m) => replacements.has(m.id) && m.observations.length))
    throw new Error("Cannot overwrite collected attempts");
  const fallback = collected.trace.traces.length
    ? []
    : [
        {
          id: `startup-${capture.trial.resetId}`,
          artifactHash: collected.sha256,
          clock: "monotonic" as const,
        },
      ];
  return createPerformanceEvidenceEnvelope({
    ...report,
    artifacts: [
      ...report.artifacts,
      ...collected.trace.artifacts,
      { sha256: collected.sha256, bytes: collected.bytes, kind: "trace" },
    ],
    traces: [...report.traces, ...collected.trace.traces, ...fallback],
    metrics: report.metrics.map((m) => replacements.get(m.id) ?? m),
  });
}
