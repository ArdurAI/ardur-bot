import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TraceBatch, TraceBoundary } from "@ardurbot/contracts";
import { TRACE_BOUNDARIES } from "@ardurbot/contracts";
import type {
  CrashEvidence,
  ExperimentEvidence,
  PerformanceEvidenceReport,
} from "../../performance-report.js";
import {
  CRASH_BOUNDARIES,
  canonicalSerialize,
  contentDigest,
  EXPERIMENT_DEFINITIONS,
} from "../manifest.js";
import { collectTraceEvidence, LOCAL_TRACE_BOUNDARIES } from "../trace-collector.js";
import type { MatrixResult } from "./catalog.js";

const CRASH_CONTROLS: Record<string, readonly string[]> = {
  "crash-03": ["crash-03-revoke", "crash-03-pin"],
};

function reachedBoundary(result: MatrixResult | undefined): result is MatrixResult {
  return Boolean(result && result.status !== "incomplete" && result.checks.killedAtBoundary);
}
function observedUnsafe(result: MatrixResult | undefined) {
  return (
    reachedBoundary(result) &&
    (result.status === "finding" || Object.values(result.checks).includes(false))
  );
}
const boundaryNames = new Set<string>(TRACE_BOUNDARIES);
interface PhaseTrace {
  raw?: { batches?: unknown };
  requiredBoundaries?: unknown;
}
function phaseTrace(result: MatrixResult, phase: "before" | "after"): PhaseTrace | undefined {
  const measurements = result.measurements[phase];
  if (!measurements || typeof measurements !== "object") return undefined;
  const trace = (measurements as { trace?: unknown }).trace;
  if (!trace || typeof trace !== "object") return undefined;
  return trace as PhaseTrace;
}
function batchesOf(trace: PhaseTrace | undefined): TraceBatch[] {
  const batches = trace?.raw?.batches;
  return Array.isArray(batches) ? (batches as TraceBatch[]) : [];
}
/** A missing list means the fault worker's local boundaries. An empty or unknown list is unusable. */
function recordedBoundaries(value: unknown): readonly TraceBoundary[] | null | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || !boundaryNames.has(item))
  )
    return null;
  return value as TraceBoundary[];
}
function sameBoundaries(left: readonly TraceBoundary[], right: readonly TraceBoundary[]) {
  return left.length === right.length && left.every((boundary, index) => boundary === right[index]);
}
function spanUnmeasured(reason: string | null) {
  return reason === "clock-not-calibrated" || reason === "clock-skew";
}
/**
 * Both processes must contribute a batch. Crash recollection pairs a start with a finish
 * on the recovering process whose attempt is the next lease fence. A cross-process span is a
 * wall-clock interval. The merged trace is complete when that recollection reports exactly one
 * terminal, every stored boundary, no drop, and a measured crash span. A start with no finish is
 * interrupted and does not by itself make the crash incomplete. clock-not-calibrated and
 * clock-skew leave the span unmeasured.
 */
function crashTraces(
  boundaryId: string,
  attempts: readonly MatrixResult[],
):
  | { status: "complete"; fragment: ReturnType<typeof collectTraceEvidence> }
  | { status: "unmeasured" }
  | { status: "missing" } {
  const phases = attempts.flatMap((attempt) =>
    (["before", "after"] as const).map((phase) => {
      const trace = phaseTrace(attempt, phase);
      return { batches: batchesOf(trace), recorded: recordedBoundaries(trace?.requiredBoundaries) };
    }),
  );
  if (
    phases.some(
      (phase) => phase.recorded === null || !phase.batches.some((batch) => batch.points.length),
    )
  )
    return { status: "missing" };
  const boundaries = phases.map((phase) => phase.recorded ?? LOCAL_TRACE_BOUNDARIES);
  const requiredBoundaries = boundaries[0];
  if (!requiredBoundaries || boundaries.some((list) => !sameBoundaries(requiredBoundaries, list)))
    return { status: "missing" };
  try {
    const fragment = collectTraceEvidence(
      phases.flatMap((phase) => phase.batches),
      { sessionId: boundaryId, pairId: null, requiredBoundaries, pairAcrossProcesses: true },
    );
    if (
      fragment.derived.some((trace) =>
        trace.operations.some((operation) => spanUnmeasured(operation.duration.reason)),
      )
    )
      return { status: "unmeasured" };
    if (
      fragment.derived.length === 0 ||
      fragment.coverage.dropped ||
      fragment.derived.some((trace) => !trace.complete)
    )
      return { status: "missing" };
    return { status: "complete", fragment };
  } catch {
    return { status: "missing" };
  }
}

/** W0-1 report fragments, alongside detailed raw probes; never an alternate release contract. */
export function matrixEvidence(results: readonly MatrixResult[]) {
  const experiments: ExperimentEvidence[] = EXPERIMENT_DEFINITIONS.map(({ id, variants }) => ({
    id,
    variants: variants.map((variant) => ({
      id: variant,
      status: id === "O13" ? "feature-not-implemented" : "incomplete",
      missingReason: id === "O13" ? "feature-not-implemented" : "not-measured",
      traceIds: [],
    })),
  }));
  const traces = new Map<string, PerformanceEvidenceReport["traces"][number]>();
  const artifacts = new Map<string, PerformanceEvidenceReport["artifacts"][number]>();
  const rawTraces: unknown[] = [];
  const crashes: CrashEvidence[] = CRASH_BOUNDARIES.map((boundary) => {
    const result = results.find((item) => item.id === boundary.id);
    const controls = (CRASH_CONTROLS[boundary.id] ?? []).map((id) => ({
      id,
      result: results.find((item) => item.id === id),
    }));
    // A control counts only when it reached its boundary and passed; its id alone proves nothing.
    const missingControls = controls
      .filter((control) => !reachedBoundary(control.result))
      .map((control) => control.id);
    const candidates = [result, ...controls.map((control) => control.result)];
    const unsafe = candidates.some(observedUnsafe);
    const attempts = candidates.filter(reachedBoundary);
    const after = result?.measurements.after as { autonomousCompletion?: boolean } | undefined;
    const traced = reachedBoundary(result) ? crashTraces(boundary.id, attempts) : null;
    const fragment = traced?.status === "complete" ? traced.fragment : null;
    const complete =
      reachedBoundary(result) &&
      missingControls.length === 0 &&
      !unsafe &&
      fragment !== null &&
      typeof after?.autonomousCompletion === "boolean";
    const missingReason: CrashEvidence["missingReason"] = complete
      ? null
      : !reachedBoundary(result)
        ? "not-measured"
        : unsafe
          ? "invalid-trial"
          : missingControls.length === 2
            ? "missing-revoke-and-pin-controls"
            : missingControls[0] === "crash-03-revoke"
              ? "missing-revoke-control"
              : missingControls[0] === "crash-03-pin"
                ? "missing-pin-control"
                : traced?.status === "unmeasured"
                  ? "crash-span-unmeasured"
                  : "trace-links-missing";
    if (complete && fragment) {
      for (const trace of fragment.traces) traces.set(trace.id, trace);
      for (const artifact of fragment.artifacts) artifacts.set(artifact.sha256, artifact);
      rawTraces.push(fragment.raw);
    }
    return {
      id: boundary.id,
      status: complete ? "complete" : "incomplete",
      missingReason,
      recovery: complete ? (boundary.expected as CrashEvidence["recovery"]) : null,
      // An observed unsafe effect fails safety even when the base attempt was not measured.
      safetyPassed: unsafe ? false : complete ? true : null,
      taskCompleted: complete ? after!.autonomousCompletion! : null,
      traceIds: complete && fragment ? fragment.traces.map((trace) => trace.id) : [],
    };
  });
  return {
    experiments,
    crashes,
    traces: [...traces.values()],
    artifacts: [...artifacts.values()],
    rawTraces,
  };
}

export async function matrixSourceBinding() {
  const git = (...args: string[]) =>
    execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean)
    .sort();
  return {
    baseCommit: git("rev-parse", "HEAD").trim(),
    diffDigest: contentDigest({
      tracked: git("diff", "--binary", "HEAD"),
      untracked: await Promise.all(
        untracked.map(async (file) => ({
          path: file,
          sha256: createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        })),
      ),
    }),
    lockDigest: createHash("sha256")
      .update(await readFile("pnpm-lock.yaml"))
      .digest("hex"),
  };
}

export async function writeMatrixArtifact(directory: string, kind: string, payload: unknown) {
  if (!/^[a-z0-9-]+$/.test(kind)) throw new Error("Invalid artifact kind");
  await mkdir(directory, { recursive: true });
  const sha256 = contentDigest(payload);
  const file = `${kind}-${sha256}.json`;
  const envelope = { algorithm: "sha256", sha256, payload };
  await writeFile(path.join(directory, file), `${canonicalSerialize(envelope)}\n`, { flag: "wx" });
  return { path: file, sha256 };
}

/** Writes the fragments and each merged trace their crash links cite, under the same digest. */
export async function writeMatrixEvidence(directory: string, results: readonly MatrixResult[]) {
  const { rawTraces, ...fragments } = matrixEvidence(results);
  const written = [];
  for (const raw of rawTraces) written.push(await writeMatrixArtifact(directory, "trace", raw));
  written.push(await writeMatrixArtifact(directory, "scoreboard-fragments", fragments));
  return written;
}

/** Never allow the existing provisioner to implicitly download a missing image. */
export function requireCachedMatrixImages() {
  const images = ["postgres:16-alpine", "testcontainers/ryuk:0.14.0"];
  return images.map((tag) => {
    try {
      const image = JSON.parse(
        execFileSync("docker", ["image", "inspect", tag, "--format", "{{json .}}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ) as { Id: string; Size: number };
      return { tag, digest: image.Id, bytes: image.Size };
    } catch {
      throw new Error(
        `Required cached image absent: ${tag}; download size unknown until registry inspection. Provisioning not attempted.`,
      );
    }
  });
}
