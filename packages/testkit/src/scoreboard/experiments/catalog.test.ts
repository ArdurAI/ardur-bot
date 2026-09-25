import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CRASH_BOUNDARIES, contentDigest, EXPERIMENT_DEFINITIONS } from "../manifest.js";
import { experimentCoverage, matrixExitCode, matrixPlan } from "./catalog.js";
import { matrixEvidence, writeMatrixArtifact } from "./evidence.js";

describe("matrix selection and evidence", () => {
  it("keeps absent canonical crash results unknown and observed safety failures failed", () => {
    const empty = matrixEvidence([]);
    expect(empty.experiments).toHaveLength(13);
    expect(empty.crashes).toHaveLength(10);
    expect(empty.crashes.every((row) => row.safetyPassed === null && row.recovery === null)).toBe(
      true,
    );
    const failed = matrixEvidence([
      {
        id: "crash-04",
        experiment: "O9",
        tier: "T1",
        status: "finding",
        checks: { killedAtBoundary: true, noDuplicateEffect: false },
        measurements: {},
        coverage: [],
        gaps: [],
      },
    ]);
    expect(failed.crashes[3]).toMatchObject({
      status: "complete",
      safetyPassed: false,
      recovery: null,
      taskCompleted: null,
    });
  });
  it("retains every canonical experiment, variant and owner without marking declarations passed", () => {
    const coverage = experimentCoverage();
    expect(coverage.map((row) => row.id)).toEqual(
      Array.from({ length: 13 }, (_, i) => `O${i + 1}`),
    );
    for (const row of coverage) {
      expect(row.owners.length).toBeGreaterThan(0);
      expect(row.variants).toEqual(
        EXPERIMENT_DEFINITIONS.find((item) => item.id === row.id)?.variants,
      );
      expect(row.status).not.toBe("passed");
    }
    expect(coverage.find((row) => row.id === "O13")?.status).toBe("feature-not-implemented");
  });
  it("keeps all ten fault expectations and expands the declared cross products", () => {
    const smoke = matrixPlan("smoke");
    const release = matrixPlan("release");
    expect(smoke.faults).toEqual(CRASH_BOUNDARIES);
    expect(smoke.requiredComparisonPairs).toBe(1);
    expect(matrixPlan("commit").requiredComparisonPairs).toBe(20);
    expect(release.requiredComparisonPairs).toBe(200);
    expect(release.memory).toHaveLength(6);
    expect(release.load).toHaveLength(6);
    expect(release.connectors).toEqual([0, 10, 50]);
    expect(release.releaseEligible).toBe(false);
    expect(() => matrixPlan("unknown" as never)).toThrow();
  });
  it("cannot turn absent observations, missing release coverage or a failed safety check into pass", () => {
    const result = {
      id: "fixture",
      experiment: "O9",
      tier: "T1" as const,
      status: "passed" as const,
      checks: { safety: true },
      measurements: {},
      coverage: [],
      gaps: [],
    };
    expect(matrixExitCode([], false)).toBe(2);
    expect(matrixExitCode([result], false)).toBe(0);
    expect(matrixExitCode([result], true)).toBe(2);
    expect(matrixExitCode([{ ...result, checks: { safety: false } }], false)).toBe(1);
    expect(matrixExitCode([{ ...result, status: "incomplete" }], false)).toBe(2);
  });
  it("writes checksummed immutable evidence and refuses replacing an attempt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "matrix-evidence-test-"));
    try {
      const payload = { measuredZero: 0, unknown: null, samples: [12, 400, 15] };
      const artifact = await writeMatrixArtifact(directory, "result", payload);
      const saved = JSON.parse(await readFile(path.join(directory, artifact.path), "utf8"));
      expect(contentDigest(saved.payload)).toBe(artifact.sha256);
      expect(saved.payload.samples).toEqual([12, 400, 15]);
      await expect(writeMatrixArtifact(directory, "result", payload)).rejects.toMatchObject({
        code: "EEXIST",
      });
      await expect(writeMatrixArtifact(directory, "../escape", payload)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
