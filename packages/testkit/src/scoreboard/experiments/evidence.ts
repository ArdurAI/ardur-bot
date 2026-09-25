import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TraceBatch } from "@ardurbot/contracts";
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
import { collectTraceEvidence } from "../trace-collector.js";
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
/** Trace batches the interrupted and the recovering process each reported for this attempt. */
function phaseBatches(result: MatrixResult): TraceBatch[] {
  return (["before", "after"] as const).flatMap((phase) => {
    const batches = (
      result.measurements[phase] as { trace?: { raw?: { batches?: unknown } } | null } | undefined
    )?.trace?.raw?.batches;
    return Array.isArray(batches) ? (batches as TraceBatch[]) : [];
  });
}
/** One fragment per crash, so the interrupted and recovering phases of a run share one trace id. */
function crashTraces(boundaryId: string, attempts: readonly MatrixResult[]) {
  if (!attempts.every((attempt) => phaseBatches(attempt).some((batch) => batch.points.length)))
    return null;
  try {
    return collectTraceEvidence(attempts.flatMap(phaseBatches), {
      sessionId: boundaryId,
      pairId: null,
      requiredBoundaries: [],
    });
  } catch {
    return null;
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
    const fragment = reachedBoundary(result) ? crashTraces(boundary.id, attempts) : null;
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
                : fragment === null
                  ? "trace-links-missing"
                  : "invalid-trial";
    if (complete) {
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
      traceIds: complete ? fragment.traces.map((trace) => trace.id) : [],
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
