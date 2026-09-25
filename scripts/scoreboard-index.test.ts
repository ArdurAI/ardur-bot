import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { createPerformanceEvidenceEnvelope } from "../packages/testkit/src/performance-report.ts";
import {
  CRASH_BOUNDARIES,
  contentDigest,
  EXPERIMENT_DEFINITIONS,
  METRIC_DEFINITIONS,
  SCOREBOARD_MANIFEST,
  TASK_DEFINITIONS,
} from "../packages/testkit/src/scoreboard/manifest.ts";
import { STARTUP_STRATA } from "../packages/testkit/src/scoreboard/packaged/plan.ts";
import { inventoryArtifact } from "../packages/testkit/src/scoreboard/resources/artifacts.ts";
import {
  createBudgetPolicy,
  freezeBudgetPolicy,
} from "../packages/testkit/src/scoreboard/statistics.ts";
import { releaseNotes } from "./desktop-release.mjs";
import {
  appendIndexRecord,
  assertWorkflowContracts,
  auditCommits,
  baselineMeasurementPlan,
  COMMIT_OBJECT_RETENTION_DAYS,
  evidenceFor,
  parseRevListParents,
  planEvidenceRecords,
  pruneCommitObjects,
  RELEASE_EVIDENCE_RETENTION,
  REQUIRED_RELEASE_TARGETS,
  readIndex,
  renderScoreboardNotes,
  runReleaseGate,
  SCOREBOARD_INDEX_RELATIVE_PATH,
  samplePlanFor,
  selectCommitRange,
  WORKFLOW_ARTIFACT_RETENTION_DAYS,
} from "./scoreboard-index.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const hash = (value: string) => contentDigest(value);
const performanceYaml = readFileSync(
  new URL("../.github/workflows/performance.yml", import.meta.url),
  "utf8",
);
const releaseYaml = readFileSync(
  new URL("../.github/workflows/release-desktop.yml", import.meta.url),
  "utf8",
);
const docs = readFileSync(new URL("../docs/performance.md", import.meta.url), "utf8");

const goodPerformance = `
on:
  workflow_call:
    inputs:
      candidate_sha:
      base_sha:
      suite_version:
      environment:
      common_runner_sha:
      mode:
      gate:
      release_version:
concurrency:
  cancel-in-progress: false
jobs:
  budgets:
    if: inputs.gate != 'required'
  release-gate:
    if: inputs.gate == 'required'
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: false
      - run: node scripts/desktop-release-assets.mjs version source publication/release-ready
      - env:
          SCOREBOARD_ARTIFACTS: publication/release-ready
        run: node scripts/scoreboard-index.mjs release-gate
  index:
    needs: budgets
    if: always() && inputs.gate != 'required'
    concurrency:
      group: scoreboard-index-\${{ github.ref }}
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v4
        with:
          run-id: prior-run
          github-token: token
      - run: node scripts/scoreboard-index.mjs restore-index
      - env:
          SCOREBOARD_HEAD: github.event.pull_request.head.sha
          SCOREBOARD_PENDING: needs.budgets.outputs.pending_reason
        run: node scripts/scoreboard-index.mjs index-push
      - run: node scripts/scoreboard-index.mjs baseline-decision
      - run: echo retention-days: 90
      - run: echo Measure current revision and retain traces
      - run: echo .context/performance/scoreboard-index
`;
const goodRelease = `
concurrency:
  cancel-in-progress: false
jobs:
  evidence:
    needs: [validate, build]
    uses: ./.github/workflows/performance.yml
    with:
      gate: required
  publish:
    needs: [validate, build, evidence]
    steps:
      - run: node scripts/desktop-release.mjs notes tag scoreboard-publication/gate.json
      - run: |
          trap cleanup EXIT
          node scripts/scoreboard-index.mjs verify-publication --directory release-ready --gate scoreboard-publication/gate.json
          node scripts/scoreboard-index.mjs list-upload --directory release-ready
          gh release delete
          gh release create
          created=1
          gh release upload
`;

function pending(commit: string, attempt = 1, supersedes: string | null = null) {
  return {
    status: "pending" as const,
    tier: "commit" as const,
    mode: "commit" as const,
    commit,
    parentCommit: null,
    fixedReleaseCommit: null,
    suiteVersion: "scoreboard-1",
    environment: "ubuntu-24.04-diagnostic",
    environmentHash: null,
    role: "candidate" as const,
    indexedAt: "2026-09-25T00:00:00.000Z",
    runnerCommit: A,
    attempt,
    supersedes,
    pendingReason: "schema-3-evidence-not-produced",
  };
}

function syntheticReport(count: number, id: string) {
  const environment = {
    platform: "linux",
    arch: "x64",
    hardwareClass: "synthetic-fixture",
    osVersion: "fixture-1",
    runtimeVersions: [{ id: "node", version: "fixture-1" }],
    containerDigests: [hash("container")],
    buildMode: "production",
    powerMode: "fixed",
    thermalState: "nominal",
    backgroundLoad: "isolated",
    memoryAccounting: "rss" as const,
    resourceLimitsHash: hash("resources"),
    sampleIntervalMs: 1000,
  };
  const report = {
    schemaVersion: 3 as const,
    id,
    createdAt: "2026-01-04T00:00:00.000Z",
    manifestHash: contentDigest(SCOREBOARD_MANIFEST),
    build: {
      commit: A,
      parentCommit: B,
      fixedReleaseCommit: C,
      dirty: false,
      diffDigest: null,
      artifactHash: hash("build"),
    },
    hashes: {
      benchmark: hash("benchmark"),
      fixture: hash("fixture"),
      grader: hash("grader"),
      dependencyLock: hash("lock"),
    },
    environment,
    environmentHash: contentDigest(environment),
    scenario: {
      id: "synthetic-scenario",
      tier: "T1" as const,
      comparisonMode: "controlled-harness" as const,
      timingMode: "zero-service-delay" as const,
      cacheState: "warm",
      loadScheduleHash: hash("load"),
      routeHash: hash("route"),
      deadlineMs: 10000,
    },
    artifacts: [
      { sha256: hash("trace"), kind: "trace" as const, bytes: 1 },
      { sha256: hash("build"), kind: "build" as const, bytes: 1 },
      { sha256: hash("raw"), kind: "raw" as const, bytes: 1 },
    ],
    traces: [{ id: "trace-01", artifactHash: hash("trace"), clock: "monotonic" as const }],
    metrics: METRIC_DEFINITIONS.map((metric) => ({
      id: metric.id,
      unit: metric.unit,
      direction: metric.direction,
      applicability: "applicable" as const,
      missingReason: metric.id === "m13.wrong-pin" ? null : ("not-measured" as const),
      coverage: {
        expected: metric.id === "m13.wrong-pin" ? count : 0,
        observed: metric.id === "m13.wrong-pin" ? count : 0,
      },
      observations:
        metric.id === "m13.wrong-pin"
          ? Array.from({ length: count }, (_, index) => ({
              id: `obs-${index}`,
              sessionId: `session-${index}`,
              pairId: `pair-${index}`,
              traceId: "trace-01",
              outcome: "success" as const,
              value: 0,
              missingReason: null,
              provenance: { kind: "measured" as const, sourceHash: hash("raw") },
            }))
          : [],
    })),
    tasks: TASK_DEFINITIONS.map((task) => ({
      id: task.id,
      status: "incomplete" as const,
      missingReason: "not-measured" as const,
      fixtureHash: null,
      graderHash: null,
      trials: [],
    })),
    experiments: EXPERIMENT_DEFINITIONS.map((experiment) => ({
      id: experiment.id,
      variants: experiment.variants.map((variant) => ({
        id: variant,
        status: "feature-not-implemented" as const,
        missingReason: "feature-not-implemented" as const,
        traceIds: [],
      })),
    })),
    crashes: CRASH_BOUNDARIES.map((boundary) => ({
      id: boundary.id,
      status: "incomplete" as const,
      missingReason: "not-measured" as const,
      recovery: null,
      safetyPassed: null,
      taskCompleted: null,
      traceIds: [],
    })),
    usageCoverage: { expected: 0, observed: 0 },
    usage: [],
  };
  return report;
}

function addStartupSamples(report: ReturnType<typeof syntheticReport>, count: number) {
  for (const metric of report.metrics) {
    if (!metric.id.startsWith("m09.")) continue;
    metric.missingReason = null;
    metric.coverage = {
      expected: count * STARTUP_STRATA.length,
      observed: count * STARTUP_STRATA.length,
    };
    metric.observations = STARTUP_STRATA.flatMap((stratum) =>
      Array.from({ length: count }, (_, index) => ({
        id: `startup-${metric.id}-${stratum}-${index}`,
        sessionId: `session-${stratum}-${index}`,
        pairId: `${stratum}-${index}`,
        traceId: "trace-01",
        outcome: "success" as const,
        value: 1,
        missingReason: null,
        provenance: { kind: "measured" as const, sourceHash: hash("raw") },
      })),
    );
  }
}

const TARGETS = [
  ["desktop-mac-arm64", "desktop-darwin-arm64", "synthetic.dmg", "darwin"],
  ["desktop-mac-x64", "desktop-darwin-x64", "synthetic.dmg", "darwin"],
  ["desktop-linux-x64", "desktop-linux-x64", "synthetic.AppImage", "linux"],
  ["desktop-win-x64", "desktop-win32-x64", "synthetic.exe", "win32"],
] as const;

function energyPair(binding: {
  artifactHash: string;
  environmentHash: string;
  workloadHash: string;
  platform: "darwin" | "linux" | "win32";
  hardwareClass: string;
  conditionsHash: string;
  durationMs: number;
}) {
  const instrument = {
    id: "fixture-meter",
    method: "joule-counter" as const,
    scope: "whole-system" as const,
    calibrationHash: hash("energy-cal"),
    calibratedAt: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-02-01T00:00:00.000Z",
    uncertaintyPercent: 1,
  };
  const idle = {
    version: 1 as const,
    binding,
    instrument,
    measuredAt: "2026-01-04T00:00:00.000Z",
    physical: true as const,
    samples: [
      { atMs: 0, value: 0 },
      { atMs: binding.durationMs, value: 1 },
    ],
    idleControlHash: null,
  };
  return {
    capture: {
      ...structuredClone(idle),
      samples: [
        { atMs: 0, value: 10 },
        { atMs: binding.durationMs, value: 12 },
      ],
      idleControlHash: contentDigest(idle),
    },
    idle,
  };
}

async function writeReleaseCase(count: number, withEnergy: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-release-"));
  const artifactRoot = path.join(root, "artifacts");
  const reportsRoot = path.join(root, "reports");
  await mkdir(reportsRoot, { recursive: true });
  const parent = syntheticReport(count, "parent-report");
  addStartupSamples(parent, SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum);
  parent.build.commit = B;
  parent.build.parentCommit = D;
  parent.build.fixedReleaseCommit = C;
  const candidate = structuredClone(parent);
  candidate.id = "candidate-report";
  candidate.build.commit = A;
  candidate.build.parentCommit = B;
  const fixed = structuredClone(parent);
  fixed.id = "fixed-report";
  fixed.build.commit = C;
  const calibrationA = structuredClone(parent);
  calibrationA.id = "calibration-a";
  calibrationA.createdAt = "2026-01-01T00:00:00.000Z";
  const calibrationB = structuredClone(calibrationA);
  calibrationB.id = "calibration-b";
  calibrationB.createdAt = "2026-01-02T00:00:00.000Z";
  const proposed = createBudgetPolicy(
    {
      metricIds: ["m13.wrong-pin"],
      taskIds: [],
      experimentIds: [],
      crashBoundaryIds: [],
      usage: false,
    },
    { mode: "release", environmentHash: parent.environmentHash, scenario: parent.scenario },
  );
  const policy = freezeBudgetPolicy(
    proposed,
    [
      createPerformanceEvidenceEnvelope(calibrationA),
      createPerformanceEvidenceEnvelope(calibrationB),
    ],
    "2026-01-03T00:00:00.000Z",
  );
  const files = [];
  for (const [directory, target, name, platform] of TARGETS) {
    const body = Buffer.from(`installer-${target}`);
    const file = path.join(artifactRoot, directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    files.push({
      target,
      name,
      platform,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: body.length,
    });
  }
  candidate.build.artifactHash = files[2]!.sha256;
  candidate.artifacts = [
    { sha256: hash("trace"), kind: "trace", bytes: 1 },
    { sha256: hash("raw"), kind: "raw", bytes: 1 },
    ...files.map((file) => ({ sha256: file.sha256, bytes: file.bytes, kind: "build" as const })),
  ];
  await writeFile(
    path.join(reportsRoot, "parent.json"),
    JSON.stringify(createPerformanceEvidenceEnvelope(parent)),
  );
  const candidateBytes = JSON.stringify(createPerformanceEvidenceEnvelope(candidate));
  await writeFile(path.join(reportsRoot, "candidate.json"), candidateBytes);
  await writeFile(path.join(artifactRoot, "scoreboard-candidate.json"), candidateBytes);
  await writeFile(
    path.join(reportsRoot, "fixed-release.json"),
    JSON.stringify(createPerformanceEvidenceEnvelope(fixed)),
  );
  await writeFile(path.join(reportsRoot, "policy.json"), JSON.stringify(policy));
  if (withEnergy) {
    await writeFile(
      path.join(reportsRoot, "energy.json"),
      JSON.stringify(
        files.map((file) => {
          const plan = {
            artifactHash: file.sha256,
            environmentHash: hash(`energy-env-${file.target}`),
            workloadHash: contentDigest({
              suiteVersion: SCOREBOARD_MANIFEST.suiteVersion,
              releaseSamplePlan: {
                replayPairs: SCOREBOARD_MANIFEST.samplePlan.releaseReplayPairs,
                startupObservationsPerStratum:
                  SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum,
                startupStrata: STARTUP_STRATA,
              },
              target: file.target,
            }),
            platform: file.platform,
            hardwareClass: `fixture-${file.target}`,
            conditionsHash: hash(`energy-conditions-${file.target}`),
            durationMs: SCOREBOARD_MANIFEST.samplePlan.releaseReplayPairs * 1000,
          };
          return { target: file.target, plan, ...energyPair(plan) };
        }),
      ),
    );
  }
  return { root, artifactRoot, reportsRoot };
}

async function gate(caseRoot: Awaited<ReturnType<typeof writeReleaseCase>>, indexName = "index") {
  const outputPath = path.join(caseRoot.root, "gate.json");
  const code = await runReleaseGate({
    artifactRoot: caseRoot.artifactRoot,
    reportsRoot: caseRoot.reportsRoot,
    outputPath,
    indexRoot: path.join(caseRoot.root, indexName),
    candidateSha: A,
    baseSha: B,
    fixedReleaseSha: C,
    runnerCommit: A,
    environment: "release-packaged",
    indexedAt: "2026-09-25T00:00:00.000Z",
  });
  const parsed = JSON.parse(await readFile(outputPath, "utf8"));
  return { code, gate: parsed, indexRoot: path.join(caseRoot.root, indexName) };
}

describe("scoreboard index", () => {
  it("keeps the local index content-addressed and declares retention", async () => {
    expect(SCOREBOARD_INDEX_RELATIVE_PATH).toBe(".context/performance/scoreboard-index");
    expect(COMMIT_OBJECT_RETENTION_DAYS).toBe(180);
    expect(WORKFLOW_ARTIFACT_RETENTION_DAYS).toBe(90);
    expect(RELEASE_EVIDENCE_RETENTION).toBe("github-release-lifetime");
    expect(REQUIRED_RELEASE_TARGETS).toEqual([
      "desktop-darwin-arm64",
      "desktop-darwin-x64",
      "desktop-linux-x64",
      "desktop-win32-x64",
    ]);
    expect(SCOREBOARD_MANIFEST.samplePlan).toMatchObject({
      commitPairs: 20,
      releaseReplayPairs: 200,
      releaseStartupObservationsPerStratum: 100,
    });
    await expect(samplePlanFor("commit")).resolves.toEqual({
      label: "commit-short",
      declaredSamples: { pairs: 20, startupPerStratum: null },
    });
    await expect(samplePlanFor("release")).resolves.toEqual({
      label: "release-grade",
      declaredSamples: { pairs: 200, startupPerStratum: 100 },
    });
  });

  it("plans a record for every enumerated commit and rejects an extra measurement", () => {
    const planned = planEvidenceRecords({
      commits: [
        { commit: A, parentCommit: null },
        { commit: B, parentCommit: A },
      ],
      measurements: [{ commit: A, pendingReason: "infrastructure-unavailable" }],
      pendingReason: "schema-3-evidence-not-produced",
    });
    expect(planned.map((item) => [item.commit, item.pendingReason])).toEqual([
      [A, "infrastructure-unavailable"],
      [B, "schema-3-evidence-not-produced"],
    ]);
    expect(() =>
      planEvidenceRecords({
        commits: [{ commit: A, parentCommit: null }],
        measurements: [{ commit: B, pendingReason: "not-measured" }],
        pendingReason: "not-measured",
      }),
    ).toThrow(/unenumerated-commit/);
    expect(parseRevListParents(`${B} ${A} ${C}\n${A}\n`)).toEqual([
      { commit: B, parentCommit: A },
      { commit: A, parentCommit: null },
    ]);
    expect(selectCommitRange({ eventName: "push", before: B, head: A })).toEqual({
      kind: "range",
      base: B,
      head: A,
    });
    expect(selectCommitRange({ eventName: "push", before: "0".repeat(40), head: A })).toEqual({
      kind: "history",
      head: A,
    });
    expect(selectCommitRange({ eventName: "pull_request", base: B, head: A }).kind).toBe("range");
    expect(selectCommitRange({ eventName: "workflow_call", head: A })).toEqual({
      kind: "single",
      head: A,
    });
    expect(selectCommitRange({ mode: "release", eventName: "push", before: B, head: A })).toEqual({
      kind: "single",
      head: A,
    });
    expect(() => selectCommitRange({ eventName: "push", before: "main", head: A })).toThrow();
  });

  it("never copies candidate production code into the baseline tree", () => {
    expect(
      baselineMeasurementPlan({
        baseHarnessPresent: false,
        runnerSha: A,
        candidateSha: A,
        baseSha: B,
      }),
    ).toEqual({
      copyProductionIntoBaseline: false,
      independentTrees: ["candidate", "base"],
      measureBaseline: false,
      pendingReason: "benchmark-runner-incompatible",
    });
    expect(
      baselineMeasurementPlan({
        baseHarnessPresent: true,
        runnerSha: A,
        candidateSha: C,
        baseSha: B,
      }).copyProductionIntoBaseline,
    ).toBe(false);
  });

  it("appends measured or pending records without hiding or tearing the chain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-index-"));
    try {
      const first = await appendIndexRecord(root, pending(A));
      const second = await appendIndexRecord(root, pending(B));
      const records = await readIndex(root);
      expect(records.map((record) => record.commit)).toEqual([A, B]);
      expect(second.previousHash).toBe(first.recordHash);
      expect(records[0]?.previousHash).toBe("0".repeat(64));
      expect(first.observedSamples).toBeNull();
      expect(first.declaredSamples).toEqual({ pairs: 20, startupPerStratum: null });
      expect(JSON.stringify(records)).not.toContain(root);
      const secondPending = await appendIndexRecord(root, pending(A, 2, first.recordHash));
      const measured = await appendIndexRecord(root, {
        ...pending(A, 3, secondPending.recordHash),
        status: "measured",
        envelope: syntheticReport(1, "stored-report"),
      });
      expect(measured.observedSamples).toBe(1);
      expect(measured.reportDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(secondPending.status).toBe("pending");
      await expect(
        appendIndexRecord(root, pending(A, 4, measured.recordHash)),
      ).rejects.toMatchObject({ code: "pending-hides-measurement" });
      const history = evidenceFor(await readIndex(root), {
        commit: A,
        suiteHash: first.suiteHash,
        environment: first.environment,
        role: "candidate",
        tier: "commit",
      });
      expect(history.current?.status).toBe("measured");
      expect(history.history.some((record) => record.status === "pending")).toBe(true);
      const raced = await Promise.allSettled([
        appendIndexRecord(root, pending(C)),
        appendIndexRecord(root, pending(C)),
      ]);
      expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
      const text = await readFile(path.join(root, "records.jsonl"), "utf8");
      const broken = text.replace(/"recordHash":"([a-f0-9]{64})"/, (_, value: string) => {
        const flipped = `${value.slice(0, -1)}${value.endsWith("a") ? "b" : "a"}`;
        return `"recordHash":"${flipped}"`;
      });
      await writeFile(path.join(root, "records.jsonl"), broken);
      await expect(readIndex(root)).rejects.toMatchObject({ code: "corrupt-index" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets one writer append when a holder exceeds the stale threshold", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-stale-"));
    let markHolding: () => void = () => {};
    const holding = new Promise<void>((resolve) => {
      markHolding = resolve;
    });
    try {
      const first = appendIndexRecord(root, pending(A), {
        staleMs: 30,
        timeoutMs: 2000,
        beforeAppend: () => {
          markHolding();
          return new Promise((resolve) => setTimeout(resolve, 180));
        },
      });
      const started = await Promise.race([
        holding.then(() => "held" as const),
        new Promise<"not-held">((resolve) => setTimeout(() => resolve("not-held"), 500)),
      ]);
      if (started === "held") await new Promise((resolve) => setTimeout(resolve, 50));
      const second = appendIndexRecord(root, pending(B), {
        staleMs: 30,
        timeoutMs: 2000,
      });
      const settled = await Promise.allSettled([first, second]);
      const records = await readIndex(root);
      expect(records.map((record) => record.commit)).toEqual([A, B]);
      expect(settled.filter((item) => item.status === "fulfilled")).toHaveLength(2);
      expect(settled.filter((item) => item.status === "rejected")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("times out on a live lock and recovers a stale one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-lock-"));
    try {
      await mkdir(path.join(root, "lock"));
      const owner = path.join(root, "lock", "owner");
      await writeFile(owner, "held");
      await expect(appendIndexRecord(root, pending(A), { timeoutMs: 80 })).rejects.toMatchObject({
        code: "lock-timeout",
      });
      const old = new Date(Date.now() - 60_000);
      await utimes(owner, old, old);
      await expect(appendIndexRecord(root, pending(A), { timeoutMs: 1000 })).resolves.toMatchObject(
        {
          commit: A,
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects private data and artifact digests that were not stored", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-reject-"));
    try {
      await expect(
        appendIndexRecord(root, { ...pending(A), note: "/Users/owner" }),
      ).rejects.toMatchObject({
        code: "private-data",
      });
      await expect(
        appendIndexRecord(root, { ...pending(A), environment: "person@example.com" }),
      ).rejects.toMatchObject({ code: "private-data" });
      await expect(
        appendIndexRecord(root, {
          ...pending(A),
          status: "measured",
          envelope: syntheticReport(1, "stored-report"),
          artifactDigests: [
            { name: "synthetic.dmg", sha256: hash("missing"), bytes: 1, target: null },
          ],
        }),
      ).rejects.toMatchObject({ code: "artifact-digest-mismatch" });
      expect(await readIndex(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("expires commit objects and keeps release bytes and the original record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-prune-"));
    try {
      const envelope = syntheticReport(1, "retained-report");
      const old = "2020-01-01T00:00:00.000Z";
      const kept = await appendIndexRecord(root, {
        ...pending(A),
        status: "measured",
        indexedAt: old,
        tier: "commit",
        envelope,
      });
      const release = await appendIndexRecord(root, {
        ...pending(A, 1, null),
        status: "measured",
        indexedAt: old,
        tier: "release",
        mode: "release",
        role: "parent",
        envelope,
        supersedes: null,
        attempt: 1,
      });
      const disposableReport = syntheticReport(1, "disposable-report");
      disposableReport.build.commit = B;
      const disposable = await appendIndexRecord(root, {
        ...pending(B),
        status: "measured",
        indexedAt: old,
        envelope: disposableReport,
      });
      const pruned = await pruneCommitObjects(root, new Date("2026-09-25T00:00:00.000Z"));
      expect(pruned.removed).toBe(1);
      const records = await readIndex(root);
      expect(records.some((record) => record.recordHash === disposable.recordHash)).toBe(true);
      expect(
        records.some(
          (record) => record.status === "expired" && record.expiresRecord === disposable.recordHash,
        ),
      ).toBe(true);
      await expect(
        readFile(path.join(root, "objects", disposable.objectDigest!)),
      ).rejects.toThrow();
      expect(await readFile(path.join(root, "objects", kept.objectDigest!))).toBeInstanceOf(Buffer);
      expect(release.objectDigest).toBe(kept.objectDigest);
      const audit = auditCommits(records, [A, B, C]);
      expect(audit.missing).toEqual([C]);
      expect(audit.results.find((item) => item.commit === B)?.retention).toBe("expired");
      expect(audit.complete).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("indexes a push as pending without claiming schema-3 measurements", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-push-"));
    const commits = path.join(root, "commits.json");
    try {
      await writeFile(
        commits,
        JSON.stringify([
          { commit: A, parentCommit: null },
          { commit: B, parentCommit: A },
        ]),
      );
      const result = spawnSync(
        process.execPath,
        [
          "scripts/scoreboard-index.mjs",
          "index-push",
          "--commits-file",
          commits,
          "--root",
          path.join(root, "index"),
          "--runner-sha",
          A,
          "--environment",
          "ubuntu-24.04-diagnostic",
          "--suite-version",
          "scoreboard-1",
          "--mode",
          "commit",
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      const records = await readIndex(path.join(root, "index"));
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.status === "pending")).toBe(true);
      expect(
        records.every((record) => record.pendingReason === "schema-3-evidence-not-produced"),
      ).toBe(true);
      expect(auditCommits(records, [A, B]).complete).toBe(true);
      const notes = spawnSync(
        process.execPath,
        ["scripts/desktop-release.mjs", "notes", "v0.1.0-alpha.1"],
        {
          cwd: repo,
          encoding: "utf8",
        },
      );
      expect(notes.status).toBe(1);
      expect(notes.stderr).toContain("validated scoreboard");
      expect(notes.stdout).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a prior artifact before appending and refuses a broken restored chain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-restore-"));
    const restored = path.join(root, "restored");
    const next = path.join(root, "next");
    try {
      const first = await appendIndexRecord(restored, pending(A));
      const restore = spawnSync(
        process.execPath,
        [
          "scripts/scoreboard-index.mjs",
          "restore-index",
          "--source",
          restored,
          "--root",
          next,
          "--missing-reason",
          "expired-after-90-days-inactivity",
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(restore.status).toBe(0);
      const second = await appendIndexRecord(next, pending(B));
      expect(second.previousHash).toBe(first.recordHash);
      expect((await readIndex(next)).map((record) => record.commit)).toEqual([A, B]);

      const broken = path.join(root, "broken");
      await cp(restored, broken, { recursive: true });
      const recordsFile = path.join(broken, "records.jsonl");
      await writeFile(recordsFile, (await readFile(recordsFile, "utf8")).replace(A, C));
      const refused = spawnSync(
        process.execPath,
        [
          "scripts/scoreboard-index.mjs",
          "restore-index",
          "--source",
          broken,
          "--root",
          path.join(root, "refused"),
          "--missing-reason",
          "expired-after-90-days-inactivity",
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("corrupt-index");

      const genesis = path.join(root, "genesis");
      const missing = spawnSync(
        process.execPath,
        [
          "scripts/scoreboard-index.mjs",
          "restore-index",
          "--source",
          path.join(root, "missing"),
          "--root",
          genesis,
          "--missing-reason",
          "expired-after-90-days-inactivity",
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(missing.status).toBe(0);
      const commits = path.join(root, "commits.json");
      await writeFile(commits, JSON.stringify([{ commit: A, parentCommit: null }]));
      const indexed = spawnSync(
        process.execPath,
        [
          "scripts/scoreboard-index.mjs",
          "index-push",
          "--commits-file",
          commits,
          "--root",
          genesis,
          "--runner-sha",
          A,
          "--environment",
          "ubuntu-24.04-diagnostic",
          "--suite-version",
          "scoreboard-1",
          "--mode",
          "commit",
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(indexed.status).toBe(0);
      expect((await readIndex(genesis))[0]?.chainOrigin).toBe("expired-after-90-days-inactivity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("release publication gate", () => {
  let passing: Awaited<ReturnType<typeof writeReleaseCase>>;
  beforeAll(async () => {
    passing = await writeReleaseCase(200, true);
  }, 60_000);

  it("publishes only when digests, platforms, energy, and the release sample floor agree", async () => {
    const result = await gate(passing);
    expect(result.code).toBe(0);
    expect(result.gate.allowPublication).toBe(true);
    expect(result.gate.observedSamples).toBe(200);
    expect(result.gate.observedStartupSamples).toEqual(
      Object.fromEntries(
        [
          "process-cold-os-warm",
          "chromium-cache-cold",
          "warm-relaunch",
          "fresh-install",
          "local-stack-cold",
          "reboot-cold",
        ].map((stratum) => [stratum, 100]),
      ),
    );
    expect(result.gate.energySummary).toContain("desktop-darwin-arm64");
    const records = await readIndex(result.indexRoot);
    expect(
      records
        .filter((record) => record.status === "measured")
        .map((record) => record.role)
        .sort(),
    ).toEqual(["candidate", "fixed-release", "parent"]);
    const notes = releaseNotes(
      ["feat(private/fixture): Fixture Person changed a secret"],
      result.gate,
    );
    expect(notes).toContain("Features: 1 change");
    expect(notes).toContain("Human acceptance is separate and is not granted by this evidence.");
    expect(notes).toContain("The scoreboard suite is scoreboard-1.");
    expect(notes).toContain("These measurements were taken in the release-packaged environment.");
    expect(notes).toContain("The budget policy is frozen.");
    expect(notes).toContain(
      "| m13.wrong-pin | parent | all | exact | 200 | 0 | 0..0 | 0 | within-budget |",
    );
    expect(notes).toContain("within-budget");
    expect(notes).toContain("Observed samples: 200");
    const candidateBytes = await readFile(
      path.join(passing.artifactRoot, "scoreboard-candidate.json"),
    );
    const attachedDigest = createHash("sha256").update(candidateBytes).digest("hex");
    expect(result.gate.attachedEvidenceSha256).toBe(attachedDigest);
    expect(result.gate.canonicalEnvelopeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(notes).toContain(`The attached evidence file SHA-256 is ${attachedDigest}.`);
    expect(notes).toContain("The canonical evidence envelope SHA-256 is ");
    expect(notes).toContain("Task success: unknown.");
    expect(notes).not.toContain("Suite scoreboard-1 (");
    expect(notes).not.toContain("Person");
    expect(notes).not.toContain("secret");
    expect(notes).not.toContain(passing.root);
    expect(() => renderScoreboardNotes({ ...result.gate, allowPublication: false })).toThrow(
      /human acceptance/i,
    );
  }, 60_000);

  it("blocks a statistically eligible report that is below the release sample floor", async () => {
    const short = await writeReleaseCase(199, true);
    try {
      const result = await gate(short);
      expect(result.code).toBe(2);
      expect(result.gate.allowPublication).toBe(false);
      expect(
        result.gate.reasons.some(
          (reason: { code: string }) => reason.code === "insufficient-samples",
        ),
      ).toBe(true);
      expect(
        (await readIndex(result.indexRoot)).some((record) => record.status === "measured"),
      ).toBe(false);
    } finally {
      await rm(short.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("blocks a release report with missing startup strata", async () => {
    const missingStartup = await stagePassing();
    try {
      await rewriteCandidate(missingStartup.reportsRoot, (report) => {
        for (const metric of report.metrics) {
          if (!metric.id.startsWith("m09.")) continue;
          metric.coverage = { expected: 0, observed: 0 };
          metric.observations = [];
          metric.missingReason = "not-measured";
        }
      });
      const result = await gate(missingStartup, "index-missing-startup");
      expect(result.code).not.toBe(0);
      expect(
        result.gate.reasons.some(
          (reason: { code: string }) => reason.code === "insufficient-startup-samples",
        ),
      ).toBe(true);
    } finally {
      await rm(missingStartup.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("blocks missing energy and a repackaged artifact without erasing a measured record", async () => {
    const stage = async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-stage-"));
      await cp(passing.artifactRoot, path.join(root, "artifacts"), { recursive: true });
      await cp(passing.reportsRoot, path.join(root, "reports"), { recursive: true });
      return {
        root,
        artifactRoot: path.join(root, "artifacts"),
        reportsRoot: path.join(root, "reports"),
      };
    };
    const copy = await stage();
    const tampered = await stage();
    try {
      await rm(path.join(copy.reportsRoot, "energy.json"));
      const missing = await gate(copy, "index-energy");
      expect(missing.code).toBe(2);
      expect(
        missing.gate.reasons.some((reason: { code: string }) => reason.code === "missing-energy"),
      ).toBe(true);
      const first = await gate(tampered, "index");
      expect(first.code).toBe(0);
      await writeFile(
        path.join(tampered.artifactRoot, "desktop-linux-x64", "synthetic.AppImage"),
        "repackaged",
      );
      const second = await gate(tampered, "index");
      expect(second.code).toBe(1);
      expect(
        second.gate.reasons.some(
          (reason: { code: string }) => reason.code === "artifact-digest-mismatch",
        ),
      ).toBe(true);
      const records = await readIndex(second.indexRoot);
      expect(
        records.filter((record) => record.role === "candidate" && record.status === "measured"),
      ).toHaveLength(1);
      expect(records.some((record) => record.status === "rejected")).toBe(true);
      expect(JSON.stringify(records)).not.toContain(tampered.root);
    } finally {
      await rm(copy.root, { recursive: true, force: true });
      await rm(tampered.root, { recursive: true, force: true });
    }
  }, 60_000);

  async function stagePassing() {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-probe-"));
    await cp(passing.artifactRoot, path.join(root, "artifacts"), { recursive: true });
    await cp(passing.reportsRoot, path.join(root, "reports"), { recursive: true });
    return {
      root,
      artifactRoot: path.join(root, "artifacts"),
      reportsRoot: path.join(root, "reports"),
    };
  }

  async function rewriteCandidate(
    reportsRoot: string,
    edit: (report: ReturnType<typeof syntheticReport>) => void,
  ) {
    const candidatePath = path.join(reportsRoot, "candidate.json");
    const envelope = JSON.parse(await readFile(candidatePath, "utf8")) as {
      report: ReturnType<typeof syntheticReport>;
    };
    edit(envelope.report);
    const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report));
    await writeFile(candidatePath, bytes);
    await writeFile(
      path.join(path.dirname(reportsRoot), "artifacts", "scoreboard-candidate.json"),
      bytes,
    );
  }

  async function rebindEnergy(
    reportsRoot: string,
    target: string,
    artifactHash: string,
    platform: "darwin" | "linux" | "win32",
  ) {
    const energyPath = path.join(reportsRoot, "energy.json");
    const entries = JSON.parse(await readFile(energyPath, "utf8")) as {
      target: string;
      plan: Parameters<typeof energyPair>[0];
    }[];
    await writeFile(
      energyPath,
      JSON.stringify(
        entries.map((entry) => {
          if (entry.target !== target) return entry;
          const plan = { ...entry.plan, artifactHash, platform };
          return { target, plan, ...energyPair(plan) };
        }),
      ),
    );
  }

  it("accepts derived feeds beside installers and rejects an uploaded byte the gate did not record", async () => {
    const probe = await stagePassing();
    try {
      for (const [directory, target] of TARGETS) {
        await writeFile(
          path.join(probe.artifactRoot, directory, "synthetic.blockmap"),
          `blockmap-${target}`,
        );
        await writeFile(
          path.join(probe.artifactRoot, directory, "latest-feed.yml"),
          `feed-${target}\n`,
        );
      }
      const result = await gate(probe);
      expect(result.code).toBe(0);
      expect(result.gate.allowPublication).toBe(true);
      expect(
        result.gate.distributedDigests.some(
          (file: { name: string }) => file.name === "synthetic.blockmap",
        ),
      ).toBe(true);
      const { verifyPublicationBytes } = await import("./scoreboard-index.mjs");
      await verifyPublicationBytes(probe.artifactRoot, result.gate);
      await writeFile(
        path.join(probe.artifactRoot, "desktop-linux-x64", "latest-feed.yml"),
        "changed-feed\n",
      );
      await expect(verifyPublicationBytes(probe.artifactRoot, result.gate)).rejects.toMatchObject({
        code: "artifact-digest-mismatch",
      });
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("accepts energy bound to the zip shipped beside a dmg", async () => {
    const zipCase = await stagePassing();
    try {
      const zipBody = Buffer.from("installer-zip-desktop-darwin-arm64");
      const zipPath = path.join(zipCase.artifactRoot, "desktop-mac-arm64", "synthetic.zip");
      await writeFile(zipPath, zipBody);
      const zipHash = createHash("sha256").update(zipBody).digest("hex");
      await rewriteCandidate(zipCase.reportsRoot, (report) => {
        report.artifacts.push({ sha256: zipHash, bytes: zipBody.length, kind: "build" });
      });
      await rebindEnergy(zipCase.reportsRoot, "desktop-darwin-arm64", zipHash, "darwin");
      const zipResult = await gate(zipCase, "index-zip");
      expect(zipResult.code).toBe(0);
      expect(
        zipResult.gate.reasons.some((reason: { code: string }) => reason.code === "missing-energy"),
      ).toBe(false);
    } finally {
      await rm(zipCase.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("accepts energy bound to the installer inventory digest", async () => {
    const inventoryCase = await stagePassing();
    try {
      const dmgPath = path.join(inventoryCase.artifactRoot, "desktop-mac-arm64", "synthetic.dmg");
      const inventory = await inventoryArtifact(dmgPath);
      const fileHash = createHash("sha256")
        .update(await readFile(dmgPath))
        .digest("hex");
      expect(inventory.sha256).not.toBe(fileHash);
      await rebindEnergy(
        inventoryCase.reportsRoot,
        "desktop-darwin-arm64",
        inventory.sha256,
        "darwin",
      );
      const inventoryResult = await gate(inventoryCase, "index-inventory");
      expect(inventoryResult.code).toBe(0);
    } finally {
      await rm(inventoryCase.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses energy bound to an unrelated digest", async () => {
    const unrelated = await stagePassing();
    try {
      await rebindEnergy(
        unrelated.reportsRoot,
        "desktop-darwin-arm64",
        hash("unrelated-energy"),
        "darwin",
      );
      const refused = await gate(unrelated, "index-unrelated");
      expect(refused.code).not.toBe(0);
      expect(
        refused.gate.reasons.some((reason: { code: string }) => reason.code === "missing-energy"),
      ).toBe(true);
    } finally {
      await rm(unrelated.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a one-second unrelated workload carrying a valid installer hash", async () => {
    const unrelated = await stagePassing();
    try {
      const energyPath = path.join(unrelated.reportsRoot, "energy.json");
      const entries = JSON.parse(await readFile(energyPath, "utf8")) as {
        target: string;
        capture: { binding: { workloadHash: string; durationMs: number } };
      }[];
      const target = entries.find((entry) => entry.target === "desktop-linux-x64")!;
      target.capture.binding.workloadHash = hash("one-second-unrelated-workload");
      target.capture.binding.durationMs = 1000;
      await writeFile(energyPath, JSON.stringify(entries));
      const result = await gate(unrelated, "index-unrelated-workload");
      expect(result.code).not.toBe(0);
      expect(
        result.gate.reasons.some((reason: { code: string }) => reason.code === "missing-energy"),
      ).toBe(true);
    } finally {
      await rm(unrelated.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("records a safety refusal with every gate code instead of a missing-report pending line", async () => {
    const refusedCase = await stagePassing();
    try {
      await rewriteCandidate(refusedCase.reportsRoot, (report) => {
        for (const metric of report.metrics) {
          if (metric.id !== "m13.wrong-pin") continue;
          for (const observation of metric.observations) observation.value = 1;
        }
      });
      const result = await gate(refusedCase, "index-refusal");
      expect(result.code).toBe(1);
      const codes = [
        ...new Set(result.gate.reasons.map((reason: { code: string }) => reason.code)),
      ].sort();
      expect(codes).toEqual(expect.arrayContaining(["safety-failure", "budget-regression"]));
      const records = await readIndex(result.indexRoot);
      const candidate = records.find((record) => record.role === "candidate");
      expect(candidate?.status).toBe("refused");
      expect(candidate?.pendingReason).toBeNull();
      expect(candidate?.gateCodes).toEqual(codes);
      expect(records.some((record) => record.pendingReason === "reports-missing")).toBe(false);
    } finally {
      await rm(refusedCase.root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("workflow contracts", () => {
  it("rejects a publication job that does not need evidence", () => {
    expect(() => assertWorkflowContracts(goodPerformance, goodRelease)).not.toThrow();
    const bypass = goodRelease.replace(
      "needs: [validate, build, evidence]",
      "needs: [validate, build]",
    );
    expect(() => assertWorkflowContracts(goodPerformance, bypass)).toThrow(/evidence/);
    const copying = `${goodPerformance}\ncp apps/web/src/components/ShellSkeleton.tsx\n`;
    expect(() => assertWorkflowContracts(copying, goodRelease)).toThrow(/copies candidate code/);
  });

  it("requires the checked-in workflows to index commits and gate publication", () => {
    expect(() => assertWorkflowContracts(performanceYaml, releaseYaml)).not.toThrow();
    const head = performanceYaml.match(/SCOREBOARD_HEAD:\s*(.+)/)?.[1] ?? "";
    expect(head).toContain("github.event.pull_request.head.sha");
    expect(head.indexOf("pull_request.head.sha")).toBeLessThan(head.indexOf("github.sha"));
    expect(performanceYaml).toContain("needs.budgets.outputs.pending_reason");
    expect(performanceYaml).not.toContain("performance-runner");
    expect(releaseYaml).not.toContain("release-ready/*");
    expect(releaseYaml).toContain("gh release delete");
    expect(releaseYaml).toContain("verify-publication");
    expect(releaseYaml.split("\n  publish:\n")[1]).not.toContain("desktop-release-assets.mjs");
    expect(performanceYaml).toContain("SCOREBOARD_ARTIFACTS: publication/release-ready");
    expect(performanceYaml).not.toMatch(/github\.event_name\s*[!=]=\s*'workflow_call'/);
    expect(performanceYaml).toContain("if: inputs.gate == 'required'");
    expect(performanceYaml).toContain("if: inputs.gate != 'required'");
    expect(performanceYaml).toContain("actions/download-artifact@");
    expect(performanceYaml).toContain("run-id:");
    expect(performanceYaml).toContain("github-token:");
    expect(performanceYaml).toContain("group: scoreboard-index-");
    expect(performanceYaml).toContain("node scripts/scoreboard-index.mjs restore-index");
    expect(docs).not.toContain("third worktree");
    expect(docs).toContain("harness in the base worktree");
    expect(docs).toContain("budgets job's pending reason");
  });

  it("rejects a directory in the upload set and a publish step without draft cleanup", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scoreboard-upload-"));
    try {
      await mkdir(path.join(directory, "scoreboard-evidence"));
      await writeFile(path.join(directory, "synthetic.dmg"), "bytes");
      const { publicationFiles } = await import("./scoreboard-index.mjs");
      await expect(publicationFiles(directory)).rejects.toMatchObject({ code: "upload-directory" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const directoryUpload = goodRelease.replace(
      "list-upload --directory release-ready",
      "gh release create release-ready/*",
    );
    expect(() => assertWorkflowContracts(goodPerformance, directoryUpload)).toThrow(/directory/);
    const noCleanup = goodRelease
      .replace("trap cleanup EXIT\n", "")
      .replace("gh release delete", "true");
    expect(() => assertWorkflowContracts(goodPerformance, noCleanup)).toThrow(/draft/);
  });

  it("documents where the index lives and how long evidence is kept", () => {
    expect(docs).toContain(
      "The historical scoreboard is the local directory `.context/performance/scoreboard-index`.",
    );
    expect(docs).toContain("Commit object bytes are retained for 180 days");
    expect(docs).toContain(
      "Workflow artifacts expire after 90 days and are not the historical scoreboard.",
    );
    expect(docs).toContain("github-release-lifetime");
    expect(docs).toContain("A pending record is never deleted to hide an earlier measurement.");
  });
});
