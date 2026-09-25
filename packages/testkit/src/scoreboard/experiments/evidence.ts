import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CrashEvidence, ExperimentEvidence } from "../../performance-report.js";
import {
  CRASH_BOUNDARIES,
  canonicalSerialize,
  contentDigest,
  EXPERIMENT_DEFINITIONS,
} from "../manifest.js";
import type { MatrixResult } from "./catalog.js";

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
  const crashes: CrashEvidence[] = CRASH_BOUNDARIES.map((boundary) => {
    const result = results.find((item) => item.id === boundary.id);
    const controls = results.filter((item) => item.id.startsWith(`${boundary.id}-`));
    const measured = Boolean(
      result && result.status !== "incomplete" && result.checks.killedAtBoundary,
    );
    const after = result?.measurements.after as { autonomousCompletion?: boolean } | undefined;
    const controlFailed = controls.some(
      (control) => control.status !== "passed" || Object.values(control.checks).includes(false),
    );
    return {
      id: boundary.id,
      status: measured ? "complete" : "incomplete",
      missingReason: measured ? null : "not-measured",
      recovery:
        measured && result?.status === "passed"
          ? (boundary.expected as CrashEvidence["recovery"])
          : null,
      // A failed control is a safety failure even when the base attempt was not measured.
      safetyPassed: controlFailed
        ? false
        : measured
          ? Object.values(result!.checks).every(Boolean)
          : null,
      taskCompleted:
        measured && typeof after?.autonomousCompletion === "boolean"
          ? after.autonomousCompletion
          : null,
      traceIds: [],
    };
  });
  return { experiments, crashes };
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
