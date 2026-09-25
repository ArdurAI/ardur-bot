import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
  metricBudget,
} from "../packages/testkit/src/scoreboard/statistics.ts";
import { releaseNotes } from "./desktop-release.mjs";
import {
  appendIndexRecord,
  assertWorkflowContracts,
  auditCommits,
  baselineMeasurementPlan,
  COMMIT_OBJECT_RETENTION_DAYS,
  classifyGateCodes,
  durableIndexScope,
  evidenceFor,
  findPriorIndexArtifact,
  indexJobHistory,
  parseRevListParents,
  planEvidenceRecords,
  pruneCommitObjects,
  RELEASE_EVIDENCE_RETENTION,
  RELEASE_POLICY_SHA256,
  REQUIRED_RELEASE_TARGETS,
  readIndex,
  renderScoreboardNotes,
  reportsArtifactPresent,
  restoreIndex,
  runReleaseGate,
  SCOREBOARD_INDEX_RELATIVE_PATH,
  samplePlanFor,
  selectCommitRange,
  verifyPublicationBytes,
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
      evidence_waiver:
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
      - run: node scripts/scoreboard-index.mjs report-artifact
      - if: steps.reports.outputs.present == 'true'
        uses: actions/download-artifact@v4
        with:
          pattern: scoreboard-reports
      - run: node scripts/desktop-release-assets.mjs version source publication/release-ready
      - env:
          SCOREBOARD_ARTIFACTS: publication/release-ready
          SCOREBOARD_WAIVER: \${{ inputs.evidence_waiver }}
        run: node scripts/scoreboard-index.mjs release-gate
  index:
    needs: budgets
    if: always() && inputs.gate != 'required'
    concurrency:
      group: scoreboard-index-\${{ github.ref }}
      cancel-in-progress: false
    steps:
      - id: prior
        run: node scripts/scoreboard-index.mjs prior-index >> "$GITHUB_OUTPUT"
      - uses: actions/download-artifact@v4
        with:
          run-id: prior-run
          github-token: token
      - run: node scripts/scoreboard-index.mjs restore-index
      - env:
          SCOREBOARD_HEAD: github.event.pull_request.head.sha
          SCOREBOARD_PENDING: needs.budgets.outputs.pending_reason
        run: node scripts/scoreboard-index.mjs index-push
      - uses: actions/upload-artifact@v4
        with:
          name: \${{ steps.prior.outputs.artifact_name }}
      - run: node scripts/scoreboard-index.mjs baseline-decision
      - run: echo retention-days: 90
      - run: echo Measure current revision and retain traces
      - run: echo .context/performance/scoreboard-index
`;
const goodRelease = `
on:
  workflow_dispatch:
    inputs:
      evidence_waiver:
concurrency:
  cancel-in-progress: false
jobs:
  evidence:
    needs: [validate, build]
    uses: ./.github/workflows/performance.yml
    with:
      gate: required
      evidence_waiver: \${{ github.event_name == 'workflow_dispatch' && inputs.evidence_waiver || '' }}
  publish:
    needs: [validate, build, evidence]
    steps:
      - run: node scripts/desktop-release.mjs notes tag scoreboard-publication/gate.json
      - run: |
          node scripts/scoreboard-index.mjs verify-publication --directory release-ready --gate scoreboard-publication/gate.json
          node scripts/scoreboard-index.mjs list-upload --directory release-ready
          node scripts/release-publish.mjs --waiver-record publication/scoreboard-publication/waiver-record.json
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

function platformFor(target: string): "darwin" | "linux" | "win32" {
  const found = TARGETS.find((item) => item[1] === target);
  if (!found) throw new Error(`unknown target ${target}`);
  return found[3];
}

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

const SAFETY_COUNTS = [
  "m11.lazy-boundary-violations",
  "m13.duplicate-effects",
  "m13.false-completion",
  "m13.lost-accepted-work",
  "m13.unauthorized-effects",
  "m13.wrong-pin",
];

function fixtureReleasePolicy(extraGuardrails: { id: string; metricIds: string[] }[] = []) {
  const selection = { taskIds: [], experimentIds: [], crashBoundaryIds: [], usage: false };
  return {
    schemaVersion: 1,
    suiteVersion: SCOREBOARD_MANIFEST.suiteVersion,
    manifestHash: contentDigest(SCOREBOARD_MANIFEST),
    releaseTargets: [...REQUIRED_RELEASE_TARGETS],
    budget: {
      mode: "release",
      required: { metricIds: ["m13.wrong-pin"], ...selection },
      declarations: {
        nominalQueue: false,
        retainedSessionGrowthBytes: null,
        toolTerminationDeadlineMs: null,
      },
      seed: 0x51c0ab1e,
      resamples: 20_000,
    },
    guardrails: [
      { id: "fixture-safety", metricIds: ["m13.wrong-pin"], ...selection },
      ...extraGuardrails.map((guardrail) => ({ ...guardrail, ...selection })),
    ],
  };
}

async function writeReleasePolicy(root: string, policy: unknown) {
  const bytes = `${JSON.stringify(policy, null, 2)}\n`;
  await writeFile(path.join(root, "release-policy.json"), bytes);
  return createHash("sha256").update(bytes).digest("hex");
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
  await writeReleasePolicy(root, fixtureReleasePolicy());
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

async function gate(
  caseRoot: Awaited<ReturnType<typeof writeReleaseCase>>,
  indexName = "index",
  extra: Record<string, string | number | null> = {},
) {
  const outputPath = path.join(caseRoot.root, "gate.json");
  const releasePolicyPath = path.join(caseRoot.root, "release-policy.json");
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
    releasePolicyPath,
    releasePolicySha256: createHash("sha256")
      .update(await readFile(releasePolicyPath))
      .digest("hex"),
    ...extra,
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

  it("keeps a shared commit object while any record is inside the retention window", async () => {
    const measured = (indexedAt: string, attempt = 1, supersedes: string | null = null) => ({
      ...pending(A, attempt, supersedes),
      status: "measured" as const,
      indexedAt,
      envelope: syntheticReport(1, "shared-window"),
    });
    const kept = await mkdtemp(path.join(os.tmpdir(), "scoreboard-shared-kept-"));
    try {
      const older = await appendIndexRecord(kept, measured("2020-01-01T00:00:00.000Z"));
      const newer = await appendIndexRecord(
        kept,
        measured("2026-09-01T00:00:00.000Z", 2, older.recordHash),
      );
      expect(newer.objectDigest).toBe(older.objectDigest);
      await pruneCommitObjects(kept, new Date("2026-09-25T00:00:00.000Z"));
      expect(await readFile(path.join(kept, "objects", older.objectDigest!))).toBeInstanceOf(
        Buffer,
      );
    } finally {
      await rm(kept, { recursive: true, force: true });
    }

    const dropped = await mkdtemp(path.join(os.tmpdir(), "scoreboard-shared-dropped-"));
    try {
      const first = await appendIndexRecord(dropped, measured("2020-01-01T00:00:00.000Z"));
      const second = await appendIndexRecord(
        dropped,
        measured("2020-06-01T00:00:00.000Z", 2, first.recordHash),
      );
      expect(second.objectDigest).toBe(first.objectDigest);
      await pruneCommitObjects(dropped, new Date("2026-09-25T00:00:00.000Z"));
      await expect(readFile(path.join(dropped, "objects", first.objectDigest!))).rejects.toThrow();
    } finally {
      await rm(dropped, { recursive: true, force: true });
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
      await cp(
        path.join(passing.root, "release-policy.json"),
        path.join(root, "release-policy.json"),
      );
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
    await cp(
      path.join(passing.root, "release-policy.json"),
      path.join(root, "release-policy.json"),
    );
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

  function completeCrashes(report: ReturnType<typeof syntheticReport>) {
    for (const crash of report.crashes) {
      const expected = CRASH_BOUNDARIES.find((boundary) => boundary.id === crash.id)!.expected;
      crash.status = "complete";
      crash.missingReason = null;
      crash.recovery = expected;
      crash.safetyPassed = true;
      crash.taskCompleted = expected !== "explicit-uncertainty";
      crash.traceIds = ["trace-01"];
    }
  }

  async function writeCandidateCrashReport(reportsRoot: string) {
    const candidatePath = path.join(reportsRoot, "candidate.json");
    const envelope = JSON.parse(await readFile(candidatePath, "utf8")) as {
      report: ReturnType<typeof syntheticReport>;
    };
    envelope.report.id = "candidate-crash-report";
    envelope.report.scenario.tier = "T1";
    completeCrashes(envelope.report);
    await writeFile(
      path.join(reportsRoot, "candidate-crash.json"),
      JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report)),
    );
  }

  async function setStartupTier(caseRoot: { reportsRoot: string; artifactRoot: string }) {
    for (const name of ["parent.json", "candidate.json", "fixed-release.json"]) {
      const file = path.join(caseRoot.reportsRoot, name);
      const envelope = JSON.parse(await readFile(file, "utf8")) as {
        report: ReturnType<typeof syntheticReport>;
      };
      envelope.report.scenario.tier = "T2";
      const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report));
      await writeFile(file, bytes);
      if (name === "candidate.json")
        await writeFile(path.join(caseRoot.artifactRoot, "scoreboard-candidate.json"), bytes);
    }
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

  it("rejects energy bound to the inventory envelope and accepts the installer file bytes", async () => {
    const probe = await stagePassing();
    try {
      const envelopes = new Map<string, string>();
      const files = new Map<string, string>();
      for (const [directory, target, name] of TARGETS) {
        const full = path.join(probe.artifactRoot, directory, name);
        const inventory = await inventoryArtifact(full);
        const fileHash = createHash("sha256")
          .update(await readFile(full))
          .digest("hex");
        expect(inventory.entries[0]?.sha256).toBe(fileHash);
        expect(inventory.sha256).not.toBe(fileHash);
        envelopes.set(target, inventory.sha256);
        files.set(target, fileHash);
      }
      const missingTargets = (gateResult: Awaited<ReturnType<typeof gate>>) =>
        gateResult.gate.reasons
          .filter((reason: { code: string }) => reason.code === "missing-energy")
          .map((reason: { scope: string }) => reason.scope)
          .sort();
      for (const [target, digest] of envelopes)
        await rebindEnergy(probe.reportsRoot, target, digest, platformFor(target));
      const envelopeGate = await gate(probe, "index-envelope");
      expect(missingTargets(envelopeGate)).toEqual([...REQUIRED_RELEASE_TARGETS].sort());
      for (const [target, digest] of files)
        await rebindEnergy(probe.reportsRoot, target, digest, platformFor(target));
      const fileGate = await gate(probe, "index-file-bytes");
      expect(fileGate.code).toBe(0);
      expect(missingTargets(fileGate)).toEqual([]);
      for (const [target] of files)
        await rebindEnergy(
          probe.reportsRoot,
          target,
          hash("unrelated-energy"),
          platformFor(target),
        );
      const unrelatedGate = await gate(probe, "index-unrelated-all");
      expect(missingTargets(unrelatedGate)).toEqual([...REQUIRED_RELEASE_TARGETS].sort());
    } finally {
      await rm(probe.root, { recursive: true, force: true });
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

  const codes = (value: { reasons: { code: string }[] }) =>
    value.reasons.map((reason) => reason.code);
  const WAIVER = "Physical release runners are not provisioned";

  async function stageWithoutEvidence() {
    const staged = await stagePassing();
    await rm(staged.reportsRoot, { recursive: true, force: true });
    await mkdir(staged.reportsRoot);
    await rm(path.join(staged.artifactRoot, "scoreboard-candidate.json"));
    return staged;
  }

  function releaseGateCli(
    caseRoot: Awaited<ReturnType<typeof stagePassing>>,
    env: Record<string, string>,
    indexName: string,
  ) {
    const outputPath = path.join(caseRoot.root, `${indexName}.json`);
    const result = spawnSync(process.execPath, ["scripts/scoreboard-index.mjs", "release-gate"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        SCOREBOARD_ARTIFACTS: caseRoot.artifactRoot,
        SCOREBOARD_REPORTS: caseRoot.reportsRoot,
        SCOREBOARD_OUTPUT: outputPath,
        SCOREBOARD_INDEX: path.join(caseRoot.root, indexName),
        SCOREBOARD_CANDIDATE: A,
        SCOREBOARD_BASE: B,
        SCOREBOARD_FIXED: C,
        SCOREBOARD_RUNNER: A,
        SCOREBOARD_ENVIRONMENT: "release-packaged",
        SCOREBOARD_WAIVER: "",
        GITHUB_EVENT_NAME: "push",
        GITHUB_TRIGGERING_ACTOR: "release-operator",
        ...env,
      },
    });
    return {
      status: result.status,
      gate: JSON.parse(readFileSync(outputPath, "utf8")),
      indexRoot: path.join(caseRoot.root, indexName),
    };
  }

  it("still refuses a release with neither reports nor a waiver", async () => {
    const bare = await stageWithoutEvidence();
    try {
      const result = await gate(bare, "index-bare");
      expect(result.code).not.toBe(0);
      expect(result.gate.allowPublication).toBe(false);
      expect(codes(result.gate)).toContain("reports-missing");
      const records = await readIndex(result.indexRoot);
      expect(records.map((record) => [record.status, record.pendingReason])).toEqual([
        ["pending", "reports-missing"],
      ]);
      expect(() => renderScoreboardNotes(result.gate)).toThrow();
    } finally {
      await rm(bare.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("publishes a dispatched preview without evidence only under a recorded waiver", async () => {
    const bare = await stageWithoutEvidence();
    try {
      const result = await gate(bare, "index-waived", {
        waiver: `  ${WAIVER}.  `,
        trigger: "workflow_dispatch",
        actor: "release-operator",
        runId: 5150,
      });
      expect(result.code).toBe(0);
      expect(result.gate).toMatchObject({
        path: "waiver",
        allowPublication: true,
        reasons: [],
        waiver: { reason: WAIVER, actor: "release-operator" },
      });
      expect(result.gate).not.toHaveProperty("rows");
      expect(result.gate).not.toHaveProperty("observedSamples");
      const records = await readIndex(result.indexRoot);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        status: "waived",
        tier: "release",
        role: "candidate",
        commit: A,
        pendingReason: null,
        reportDigest: null,
        observedSamples: null,
        waiver: { reason: WAIVER, actor: "release-operator" },
      });
      expect(records[0]?.artifactDigests).toHaveLength(result.gate.distributedDigests.length);
      await verifyPublicationBytes(bare.artifactRoot, result.gate);
      const notes = releaseNotes(["feat: fixture"], result.gate);
      const evidence = notes.split("## Performance evidence\n\n")[1] ?? "";
      expect(evidence.split("\n")[0]).toBe(
        `This preview was published without measured performance evidence: ${WAIVER}. Waived by release-operator.`,
      );
      const waiverRecord = JSON.parse(
        await readFile(path.join(bare.root, "waiver-record.json"), "utf8"),
      ) as {
        reason: string;
        actor: string;
        runId: number;
        indexLine: { status: string; waiver: { actor: string } };
      };
      expect(waiverRecord).toMatchObject({
        reason: WAIVER,
        actor: "release-operator",
        runId: 5150,
        indexLine: { status: "waived", waiver: { actor: "release-operator", reason: WAIVER } },
      });
      expect(notes).not.toMatch(/Measured evidence|\| Metric|Observed samples|within-budget/);
    } finally {
      await rm(bare.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a waiver on a tag push and reads the trigger from GitHub", async () => {
    const bare = await stageWithoutEvidence();
    try {
      const pushed = releaseGateCli(bare, { SCOREBOARD_WAIVER: WAIVER }, "index-push-waiver");
      expect(pushed.status).toBe(1);
      expect(pushed.gate.allowPublication).toBe(false);
      expect(codes(pushed.gate)).toContain("waiver-not-permitted");
      const refused = await readIndex(pushed.indexRoot);
      expect(refused.map((record) => record.status)).toEqual(["refused"]);
      expect(refused[0]?.gateCodes).toContain("waiver-not-permitted");
      expect(refused[0]?.waiver).toBeNull();
      expect(() => renderScoreboardNotes(pushed.gate)).toThrow();
      const dispatched = releaseGateCli(
        bare,
        { SCOREBOARD_WAIVER: WAIVER, GITHUB_EVENT_NAME: "workflow_dispatch" },
        "index-dispatch-waiver",
      );
      expect(dispatched.status).toBe(0);
      expect((await readIndex(dispatched.indexRoot))[0]?.waiver).toEqual({
        reason: WAIVER,
        actor: "release-operator",
      });
    } finally {
      await rm(bare.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses an unsafe waiver and a waiver beside measured evidence", async () => {
    const bare = await stageWithoutEvidence();
    const measured = await stagePassing();
    try {
      const unsafe = [
        "   ",
        "Ask @maintainer",
        "See [notes](https://example.invalid)",
        "first line\nsecond line",
        "x".repeat(201),
      ];
      for (const [index, waiver] of unsafe.entries()) {
        const result = await gate(bare, `index-invalid-${index}`, {
          waiver,
          trigger: "workflow_dispatch",
          actor: "release-operator",
        });
        expect(result.code).toBe(1);
        expect(codes(result.gate)).toEqual(["invalid-waiver"]);
      }
      const actor = await gate(bare, "index-invalid-actor", {
        waiver: WAIVER,
        trigger: "workflow_dispatch",
        actor: "not a login",
      });
      expect(codes(actor.gate)).toEqual(["invalid-waiver"]);
      const both = await gate(measured, "index-waiver-evidence", {
        waiver: WAIVER,
        trigger: "workflow_dispatch",
        actor: "release-operator",
      });
      expect(both.code).toBe(1);
      expect(codes(both.gate)).toContain("waiver-with-evidence");
      expect(
        (await readIndex(both.indexRoot)).some((record) =>
          ["measured", "waived"].includes(record.status),
        ),
      ).toBe(false);
    } finally {
      await rm(bare.root, { recursive: true, force: true });
      await rm(measured.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a supplied policy that differs from the committed release policy", async () => {
    const probe = await stagePassing();
    try {
      const result = releaseGateCli(probe, {}, "index-committed-policy");
      expect(result.status).toBe(1);
      expect(codes(result.gate)).toContain("release-policy-mismatch");
      expect(result.gate.releasePolicySha256).toBe(RELEASE_POLICY_SHA256);
      expect(
        (await readIndex(result.indexRoot)).some((record) => record.status === "measured"),
      ).toBe(false);
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a release policy whose bytes differ from the pinned digest", async () => {
    const probe = await stagePassing();
    try {
      const pinned = createHash("sha256")
        .update(await readFile(path.join(probe.root, "release-policy.json")))
        .digest("hex");
      const tampered = fixtureReleasePolicy();
      tampered.guardrails = [];
      await writeReleasePolicy(probe.root, tampered);
      const result = await gate(probe, "index-unpinned", { releasePolicySha256: pinned });
      expect(result.code).toBe(1);
      expect(result.gate.allowPublication).toBe(false);
      expect(codes(result.gate)).toContain("release-policy-unpinned");
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("blocks publication while a mandatory guardrail is unknown", async () => {
    const probe = await stagePassing();
    try {
      await writeReleasePolicy(
        probe.root,
        fixtureReleasePolicy([
          { id: "effect-safety", metricIds: ["m13.unauthorized-effects", "m13.wrong-pin"] },
        ]),
      );
      const result = await gate(probe, "index-unknown-guardrail");
      expect(result.code).toBe(2);
      expect(result.gate.allowPublication).toBe(false);
      expect(result.gate.reasons).toContainEqual(
        expect.objectContaining({ code: "mandatory-evidence-unknown", scope: "effect-safety" }),
      );
      const records = await readIndex(result.indexRoot);
      expect(records.map((record) => [record.status, record.pendingReason])).toEqual([
        ["pending", "mandatory-evidence-unknown"],
      ]);
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("records an undeclared committed budget instead of missing reports", async () => {
    const probe = await stagePassing();
    try {
      const committed = JSON.parse(
        readFileSync(new URL("../docs/performance/release-policy.json", import.meta.url), "utf8"),
      ) as {
        budget: {
          required: { metricIds: string[] };
          declarations: {
            nominalQueue: boolean;
            retainedSessionGrowthBytes: number | null;
            toolTerminationDeadlineMs: number | null;
          };
          seed: number;
        };
      };
      const rewrite = async (name: string) => {
        const file = path.join(probe.reportsRoot, name);
        const envelope = JSON.parse(await readFile(file, "utf8")) as {
          report: ReturnType<typeof syntheticReport>;
        };
        envelope.report.scenario.tier = "T2";
        const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report));
        await writeFile(file, bytes);
        if (name === "candidate.json")
          await writeFile(path.join(probe.artifactRoot, "scoreboard-candidate.json"), bytes);
        return JSON.parse(bytes).report as ReturnType<typeof syntheticReport>;
      };
      await rewrite("parent.json");
      await rewrite("fixed-release.json");
      const candidate = await rewrite("candidate.json");
      const discovered = createBudgetPolicy(
        {
          metricIds: committed.budget.required.metricIds,
          taskIds: [],
          experimentIds: [],
          crashBoundaryIds: [],
          usage: false,
        },
        {
          mode: "release",
          environmentHash: candidate.environmentHash,
          scenario: candidate.scenario,
          seed: committed.budget.seed,
          resamples: 1000,
          ...committed.budget.declarations,
        },
      );
      const undeclaredIds = committed.budget.required.metricIds.filter((id) => {
        const definition = METRIC_DEFINITIONS.find((item) => item.id === id)!;
        return metricBudget(definition, discovered.policy).kind === "undeclared";
      });
      expect(undeclaredIds).toEqual(["m10.post-idle-retained", "m13.terminal-stop"]);
      const selection = {
        metricIds: undeclaredIds,
        taskIds: [],
        experimentIds: [],
        crashBoundaryIds: [],
        usage: false,
      };
      for (const name of ["parent.json", "candidate.json", "fixed-release.json"]) {
        const file = path.join(probe.reportsRoot, name);
        const envelope = JSON.parse(await readFile(file, "utf8")) as {
          report: ReturnType<typeof syntheticReport>;
        };
        for (const id of undeclaredIds) {
          const metric = envelope.report.metrics.find((item) => item.id === id)!;
          metric.missingReason = null;
          metric.coverage = { expected: 1, observed: 1 };
          metric.observations = [
            {
              id: `obs-${id.replaceAll(".", "-")}`,
              sessionId: "session-1",
              pairId: "pair-1",
              traceId: "trace-01",
              outcome: "success",
              value: 1,
              missingReason: null,
              provenance: {
                kind: id.startsWith("m13.") ? "measured" : "counted",
                sourceHash: hash("raw"),
              },
            },
          ];
        }
        const soak = envelope.report.experiments
          .find((item) => item.id === "O12")!
          .variants.find((item) => item.id === "soak-2h")!;
        soak.status = "complete";
        soak.missingReason = null;
        soak.traceIds = ["trace-01"];
        const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report));
        await writeFile(file, bytes);
        if (name === "candidate.json")
          await writeFile(path.join(probe.artifactRoot, "scoreboard-candidate.json"), bytes);
      }
      const evidencePolicy = createBudgetPolicy(selection, {
        mode: "release",
        environmentHash: candidate.environmentHash,
        scenario: candidate.scenario,
        seed: committed.budget.seed,
        resamples: 1000,
        ...committed.budget.declarations,
      });
      await writeFile(path.join(probe.reportsRoot, "policy.json"), JSON.stringify(evidencePolicy));
      await writeReleasePolicy(probe.root, {
        schemaVersion: 1,
        suiteVersion: SCOREBOARD_MANIFEST.suiteVersion,
        manifestHash: contentDigest(SCOREBOARD_MANIFEST),
        releaseTargets: [...REQUIRED_RELEASE_TARGETS],
        budget: {
          mode: "release",
          required: selection,
          declarations: committed.budget.declarations,
          seed: committed.budget.seed,
          resamples: 1000,
        },
        guardrails: [{ id: "fixture-undeclared", ...selection }],
      });
      const result = await gate(probe, "index-undeclared");
      expect(result.code).not.toBe(0);
      const record = (await readIndex(result.indexRoot)).find((item) => item.role === "candidate");
      expect(record?.pendingReason).toBe("undeclared-budget");
      expect(record?.pendingReason).not.toBe("reports-missing");
      expect(record?.metricIds).toEqual(undeclaredIds);
      expect(record?.gateCodes).toContain("undeclared-budget");
      expect(result.gate.reasons).toContainEqual(
        expect.objectContaining({
          code: "undeclared-budget",
          detail:
            "retainedSessionGrowthBytes and toolTerminationDeadlineMs are still undeclared; publication needs them declared.",
        }),
      );
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("satisfies pinned recovery from a T1 crash report beside the T2 startup report", async () => {
    const paired = await stagePassing();
    const startupOnly = await stagePassing();
    const pinnedPolicy = path.join(repo, "docs/performance/release-policy.json");
    const policyArgs = {
      releasePolicyPath: pinnedPolicy,
      releasePolicySha256: RELEASE_POLICY_SHA256,
    };
    const recovery = (gateResult: Awaited<ReturnType<typeof gate>>) =>
      gateResult.gate.reasons.filter(
        (reason: { code: string; scope: string }) =>
          reason.code === "mandatory-evidence-unknown" && reason.scope === "recovery",
      );
    try {
      await writeCandidateCrashReport(paired.reportsRoot);
      await setStartupTier(paired);
      const both = await gate(paired, "index-evidence-set", policyArgs);
      expect(recovery(both)).toEqual([]);
      await setStartupTier(startupOnly);
      const onlyStartup = await gate(startupOnly, "index-startup-only", policyArgs);
      expect(recovery(onlyStartup)).toEqual([
        expect.objectContaining({
          code: "mandatory-evidence-unknown",
          scope: "recovery",
          detail: "missing T1 durable crash report",
        }),
      ]);
    } finally {
      await rm(paired.root, { recursive: true, force: true });
      await rm(startupOnly.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("writes recovery as a sentence for a complete crash", async () => {
    const crashed = await stagePassing();
    try {
      await rewriteCandidate(crashed.reportsRoot, (report) => {
        const crash = report.crashes.find((item) => item.id === "crash-01")!;
        crash.status = "complete";
        crash.missingReason = null;
        crash.recovery = "automatic-recovery";
        crash.safetyPassed = true;
        crash.taskCompleted = true;
        crash.traceIds = ["trace-01"];
      });
      const result = await gate(crashed, "index-recovery");
      expect(result.code).toBe(0);
      const notes = releaseNotes(["fix: fixture"], result.gate);
      expect(notes).toContain(
        "Recovery: crash-01 recovered by automatic recovery, safety passed, task completed.",
      );
      expect(notes).not.toContain("safety true");
      expect(notes).not.toContain("completed true");
    } finally {
      await rm(crashed.root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("comparison reason classification", () => {
  it("puts every statistics reason in exactly one of pending or refusal", () => {
    const statistics = readFileSync(
      new URL("../packages/testkit/src/scoreboard/statistics.ts", import.meta.url),
      "utf8",
    );
    const codes = [
      ...new Set(
        [...statistics.matchAll(/reason\(\s*"([a-z0-9-]+)"/g)].map((match) => match[1] ?? ""),
      ),
    ];
    expect(codes.length).toBeGreaterThan(10);
    const index = readFileSync(new URL("./scoreboard-index.mjs", import.meta.url), "utf8");
    const pending = [
      ...(
        index.match(/export const PENDING_REASONS = Object\.freeze\(\[([\s\S]*?)\]\);/)?.[1] ?? ""
      ).matchAll(/"([a-z0-9-]+)"/g),
    ].map((match) => match[1]);
    const refusal = [
      ...(index.match(/const REFUSAL_CODES = new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? "").matchAll(
        /"([a-z0-9-]+)"/g,
      ),
    ].map((match) => match[1]);
    for (const code of codes) {
      expect({
        code,
        classes: Number(pending.includes(code)) + Number(refusal.includes(code)),
      }).toEqual({
        code,
        classes: 1,
      });
    }
    expect(() => classifyGateCodes(["not-a-real-gate-code"])).toThrow(/unknown-gate-code/);
  });
});

describe("committed release policy", () => {
  it("pins every SCOREBOARD release guardrail and a feasible budget selection", () => {
    const bytes = readFileSync(new URL("../docs/performance/release-policy.json", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(RELEASE_POLICY_SHA256);
    const policy = JSON.parse(bytes.toString("utf8"));
    expect(policy.manifestHash).toBe(contentDigest(SCOREBOARD_MANIFEST));
    expect(policy.suiteVersion).toBe(SCOREBOARD_MANIFEST.suiteVersion);
    expect(policy.releaseTargets).toEqual(REQUIRED_RELEASE_TARGETS);
    const guardrails = policy.guardrails as {
      id: string;
      metricIds: string[];
      taskIds: string[];
      crashBoundaryIds: string[];
      usage: boolean;
    }[];
    expect(guardrails.map((guardrail) => guardrail.id)).toEqual([
      "effect-safety",
      "deterministic-tasks",
      "recovery",
      "latency",
      "absolute-targets",
      "prompt-tokens",
      "cache-compaction",
      "bundle",
      "memory",
      "energy",
    ]);
    const covered = new Set(guardrails.flatMap((guardrail) => guardrail.metricIds));
    for (const id of SAFETY_COUNTS) expect(covered.has(id)).toBe(true);
    const required = policy.budget.required;
    expect([...covered].sort()).toEqual(
      [...new Set([...required.metricIds, ...SAFETY_COUNTS])].sort(),
    );
    expect(guardrails.flatMap((guardrail) => guardrail.taskIds)).toEqual(
      TASK_DEFINITIONS.map((task) => task.id),
    );
    expect(required.taskIds).toEqual(TASK_DEFINITIONS.map((task) => task.id));
    expect(guardrails.flatMap((guardrail) => guardrail.crashBoundaryIds)).toEqual(
      CRASH_BOUNDARIES.map((boundary) => boundary.id),
    );
    expect(required.crashBoundaryIds).toEqual(CRASH_BOUNDARIES.map((boundary) => boundary.id));
    expect(required.usage).toBe(true);
    expect(guardrails.find((guardrail) => guardrail.id === "prompt-tokens")?.usage).toBe(true);
    expect(policy.budget.declarations).toEqual({
      nominalQueue: true,
      retainedSessionGrowthBytes: null,
      toolTerminationDeadlineMs: null,
    });
    const report = syntheticReport(1, "policy-shape");
    const envelope = createBudgetPolicy(required, {
      mode: policy.budget.mode,
      environmentHash: report.environmentHash,
      scenario: report.scenario,
      seed: policy.budget.seed,
      resamples: policy.budget.resamples,
      ...policy.budget.declarations,
    });
    const family = (id: string) =>
      METRIC_DEFINITIONS.find((definition) => definition.id === id)!.familyId;
    for (const id of required.metricIds as string[]) {
      const definition = METRIC_DEFINITIONS.find((item) => item.id === id)!;
      if (metricBudget(definition, envelope.policy).kind !== "statistical") continue;
      const members = required.metricIds.filter(
        (other: string) => family(other) === definition.familyId,
      ).length;
      const alpha = (1 - 0.95) / (envelope.policy.familyIds.length * members * 2 * 3 * 6);
      expect((policy.budget.resamples * alpha) / 2).toBeGreaterThanOrEqual(10);
    }
  });
});

function fixedReleaseDescribeArgs(yaml: string, sha: string) {
  const line = yaml
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item.startsWith('fixed_tag="$(git describe'));
  const inner = line?.match(/^fixed_tag="\$\((git describe .+) 2>/)?.[1];
  const tokens = inner?.match(/'[^']*'|"[^"]*"|\S+/g);
  if (!tokens) throw new Error("release workflow is missing the fixed release lookup");
  const [command, ...args] = tokens.map((token) =>
    token.replace(/^['"]|['"]$/g, "").replaceAll(`$` + `{sha}`, sha),
  );
  if (command !== "git") throw new Error("release workflow is missing the fixed release lookup");
  return args;
}

function fixtureGit(cwd: string, args: string[], date = "2026-09-01T00:00:00Z") {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Scoreboard Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Scoreboard Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function fixtureCommit(cwd: string, file: string, date?: string) {
  await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
  await writeFile(path.join(cwd, file), `${file}\n`);
  fixtureGit(cwd, ["add", file], date);
  fixtureGit(cwd, ["commit", "-q", "-m", file], date);
  return fixtureGit(cwd, ["rev-parse", "HEAD"]);
}

describe("commit enumeration", () => {
  it("indexes a push whose queued run was cancelled, following first parents", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-enumerate-"));
    const work = path.join(root, "repo");
    const transport = path.join(root, "transport");
    await mkdir(work);
    try {
      fixtureGit(work, ["init", "-q", "-b", "dev"]);
      const c0 = await fixtureCommit(work, "c0");
      const c1 = await fixtureCommit(work, "c1");
      const c2 = await fixtureCommit(work, "c2");
      const push = (before: string, head: string, indexRoot: string) =>
        spawnSync(
          process.execPath,
          [path.join(repo, "scripts/scoreboard-index.mjs"), "index-push"],
          {
            cwd: work,
            encoding: "utf8",
            env: {
              ...process.env,
              SCOREBOARD_BEFORE: before,
              SCOREBOARD_BASE: "",
              SCOREBOARD_HEAD: head,
              SCOREBOARD_RUNNER: head,
              SCOREBOARD_MODE: "commit",
              SCOREBOARD_ROOT: indexRoot,
            },
          },
        );
      expect(push(c0, c2, transport).status).toBe(0);
      const c3 = await fixtureCommit(work, "c3");
      fixtureGit(work, ["checkout", "-q", "-b", "side"]);
      const side = await fixtureCommit(work, "side");
      fixtureGit(work, ["checkout", "-q", "dev"]);
      const c4 = await fixtureCommit(work, "c4");
      fixtureGit(work, ["merge", "-q", "--no-ff", "side", "-m", "merge side"]);
      const merge = fixtureGit(work, ["rev-parse", "HEAD"]);
      const c6 = await fixtureCommit(work, "c6");
      const restored = path.join(root, "restored");
      const restore = spawnSync(
        process.execPath,
        [
          "scripts/scoreboard-index.mjs",
          "restore-index",
          "--source",
          transport,
          "--root",
          restored,
          "--missing-reason",
          "first-run",
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(restore.status).toBe(0);
      const third = push(c3, c6, restored);
      expect(third.status).toBe(0);
      const records = await readIndex(restored);
      expect(records.map((record) => record.commit)).toEqual([c0, c1, c2, c3, c4, merge, c6]);
      expect(records.some((record) => record.commit === side)).toBe(false);
      expect(records.find((record) => record.commit === merge)?.parentCommit).toBe(c4);
      expect(push(c3, c6, restored).status).toBe(0);
      expect(await readIndex(restored)).toHaveLength(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("records every commit in an empty index when before is the middle commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-empty-chain-"));
    const work = path.join(root, "repo");
    const indexRoot = path.join(root, "index");
    await mkdir(work);
    try {
      fixtureGit(work, ["init", "-q", "-b", "dev"]);
      const oldest = await fixtureCommit(work, "c0");
      const middle = await fixtureCommit(work, "c1");
      const head = await fixtureCommit(work, "c2");
      const pushed = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/scoreboard-index.mjs"), "index-push"],
        {
          cwd: work,
          encoding: "utf8",
          env: {
            ...process.env,
            SCOREBOARD_BEFORE: middle,
            SCOREBOARD_BASE: "",
            SCOREBOARD_HEAD: head,
            SCOREBOARD_RUNNER: head,
            SCOREBOARD_MODE: "commit",
            SCOREBOARD_ROOT: indexRoot,
          },
        },
      );
      expect(pushed.status).toBe(0);
      const records = await readIndex(indexRoot);
      expect(records.map((record) => record.commit)).toEqual([oldest, middle, head]);
      expect(records.every((record) => record.enumerationStart === oldest)).toBe(true);
      expect(
        records.every((record) => record.enumerationReason === "empty-chain-retention-window"),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("backfills to the newest chained commit when none is an ancestor of head", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-no-ancestor-"));
    const work = path.join(root, "repo");
    const indexRoot = path.join(root, "index");
    await mkdir(work);
    try {
      fixtureGit(work, ["init", "-q", "-b", "dev"]);
      const oldest = await fixtureCommit(work, "c0");
      const middle = await fixtureCommit(work, "c1");
      const head = await fixtureCommit(work, "c2");
      fixtureGit(work, ["checkout", "--orphan", "other"]);
      fixtureGit(work, ["rm", "-q", "-r", "-f", "."]);
      const chained = await fixtureCommit(work, "orphan");
      fixtureGit(work, ["checkout", "-q", "dev"]);
      await appendIndexRecord(indexRoot, pending(chained));
      const pushed = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/scoreboard-index.mjs"), "index-push"],
        {
          cwd: work,
          encoding: "utf8",
          env: {
            ...process.env,
            SCOREBOARD_BEFORE: middle,
            SCOREBOARD_BASE: "",
            SCOREBOARD_HEAD: head,
            SCOREBOARD_RUNNER: head,
            SCOREBOARD_MODE: "commit",
            SCOREBOARD_ROOT: indexRoot,
          },
        },
      );
      expect(pushed.status).toBe(0);
      const records = await readIndex(indexRoot);
      expect(records.map((record) => record.commit)).toEqual([chained, oldest, middle, head]);
      const filled = records.filter((record) => record.commit !== chained);
      expect(filled.every((record) => record.enumerationStart === chained)).toBe(true);
      expect(filled.every((record) => record.enumerationReason === "chain-without-ancestor")).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("prior index chain", () => {
  const NOW = new Date("2026-09-25T00:00:00.000Z");
  const REPOSITORY = "ArdurAI/ardur-bot";
  type Run = {
    id: number;
    event: string;
    head_branch: string;
    head_sha: string;
    conclusion: string;
    created_at: string;
    head_repository: { full_name: string };
  };
  const run = (id: number, createdAt: string, overrides: Partial<Run> = {}): Run => ({
    id,
    event: "push",
    head_branch: "dev",
    head_sha: String(id).padStart(40, "0"),
    conclusion: "success",
    created_at: createdAt,
    head_repository: { full_name: REPOSITORY },
    ...overrides,
  });
  const artifact = (runId: number, expired: boolean) => ({
    id: runId * 10,
    name: "scoreboard-index",
    expired,
    workflow_run: { id: runId },
  });

  function matchesCreated(createdAt: string, created: string) {
    const timestamp = Date.parse(createdAt);
    if (created.startsWith(">=")) return timestamp >= Date.parse(created.slice(2));
    const bounds = created.split("..");
    if (bounds.length === 2) {
      return timestamp >= Date.parse(bounds[0] ?? "") && timestamp <= Date.parse(bounds[1] ?? "");
    }
    return true;
  }

  function fakeGitHub(
    runs: Run[],
    artifacts: Record<number, ReturnType<typeof artifact>[]>,
    pageSize = 100,
  ) {
    const calls: { pathname: string; query: Record<string, string | number> }[] = [];
    const request = async (pathname: string, query: Record<string, string | number>) => {
      calls.push({ pathname, query });
      if (pathname.endsWith("/runs")) {
        const matched = runs.filter((item) =>
          matchesCreated(item.created_at, String(query.created ?? "")),
        );
        // Filtered workflow-run searches return at most 1,000 results.
        const visible = matched.length > 1000 ? matched.slice(0, 1000) : matched;
        const page = Number(query.page);
        const workflowRuns = visible.slice((page - 1) * pageSize, page * pageSize);
        return { total_count: matched.length, workflow_runs: workflowRuns };
      }
      const id = Number(/\/runs\/(\d+)\/artifacts$/.exec(pathname)?.[1]);
      const list = artifacts[id] ?? [];
      return { total_count: list.length, artifacts: list };
    };
    return { request, calls };
  }

  function spreadPushes(count: number, order: "newest-first" | "oldest-first") {
    const oldestAt = Date.parse("2026-06-28T00:00:00.000Z");
    const newestAt = Date.parse("2026-09-24T00:00:00.000Z");
    const items = Array.from({ length: count }, (_, index) => {
      const created = new Date(oldestAt + ((newestAt - oldestAt) * index) / (count - 1));
      return run(index + 1, created.toISOString());
    });
    return order === "newest-first" ? items.toReversed() : items;
  }

  const find = (
    github: ReturnType<typeof fakeGitHub>,
    options: {
      pageSize?: number;
      hasIndexJob?: (sha: string) => boolean;
      indexJobPredates?: (date: Date) => boolean;
    } = {},
  ) =>
    findPriorIndexArtifact({
      repository: REPOSITORY,
      branch: "dev",
      request: github.request,
      now: NOW,
      hasIndexJob: () => true,
      indexJobPredates: () => false,
      ...options,
    });

  it("walks back through every page to the newest live artifact", async () => {
    const github = fakeGitHub(
      [
        run(30, "2026-09-20T00:00:00Z"),
        run(10, "2026-09-01T00:00:00Z"),
        run(20, "2026-09-10T00:00:00Z"),
      ],
      { 10: [artifact(10, false)], 20: [artifact(20, false)] },
      2,
    );
    const result = await find(github, { pageSize: 2 });
    expect(result.runId).toBe(20);
    const listings = github.calls.filter((call) => call.pathname.endsWith("/runs"));
    expect(listings.map((call) => call.query.page)).toEqual([1, 2]);
    expect(listings[0]?.pathname).toBe(
      `/repos/${REPOSITORY}/actions/workflows/performance.yml/runs`,
    );
    expect(listings[0]?.query).toMatchObject({
      branch: "dev",
      event: "push",
      status: "success",
      created: ">=2026-06-26",
      per_page: 2,
    });
    const lookups = github.calls.filter((call) => call.pathname.endsWith("/artifacts"));
    expect(lookups.map((call) => call.pathname)).toEqual([
      `/repos/${REPOSITORY}/actions/runs/30/artifacts`,
      `/repos/${REPOSITORY}/actions/runs/20/artifacts`,
    ]);
    expect(lookups[0]?.query).toMatchObject({ name: "scoreboard-index" });
    expect(result).toEqual({ runId: 20, missingReason: null });
  });

  it("keeps walking past 50 runs until a live artifact inside the retention window", async () => {
    const dated = (id: number, daysBefore: number) =>
      run(id, new Date(NOW.getTime() - daysBefore * 24 * 60 * 60 * 1000).toISOString());
    const newestFirst = Array.from({ length: 51 }, (_, index) => dated(1000 - index, index));
    const liveOn51st = fakeGitHub(newestFirst, { 950: [artifact(950, false)] });
    await expect(find(liveOn51st)).resolves.toEqual({ runId: 950, missingReason: null });
    expect(liveOn51st.calls.filter((call) => call.pathname.endsWith("/artifacts"))).toHaveLength(
      51,
    );

    const expiredThenLive = fakeGitHub(newestFirst, {
      ...Object.fromEntries(
        newestFirst.slice(0, 50).map((item) => [item.id, [artifact(item.id, true)]]),
      ),
      950: [artifact(950, false)],
    });
    await expect(find(expiredThenLive)).resolves.toEqual({ runId: 950, missingReason: null });

    const parent = await mkdtemp(path.join(os.tmpdir(), "scoreboard-hit-"));
    const source = path.join(parent, "source");
    const restored = path.join(parent, "restored");
    try {
      await appendIndexRecord(source, pending(A));
      await expect(restoreIndex(source, restored, null)).resolves.toBe("restored");
      expect((await readIndex(restored)).map((record) => record.commit)).toEqual([A]);
      await expect(access(path.join(restored, ".chain-origin"))).rejects.toThrow();
      await expect(
        restoreIndex(path.join(parent, "missing"), path.join(parent, "again"), null),
      ).rejects.toMatchObject({ code: "missing-restored-chain" });
      await expect(access(path.join(parent, "again", ".chain-origin"))).rejects.toThrow();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }

    const outside = fakeGitHub([run(8, "2026-09-01T00:00:00Z"), run(9, "2026-06-01T00:00:00Z")], {
      9: [artifact(9, false)],
    });
    await expect(find(outside)).resolves.toEqual({
      runId: null,
      missingReason: "prior-artifact-missing",
    });
    expect(outside.calls.map((call) => call.pathname)).not.toContain(
      `/repos/${REPOSITORY}/actions/runs/9/artifacts`,
    );
  });

  it("lists every run inside the window once a search passes 1000 results", async () => {
    const oldestOnly = spreadPushes(1001, "newest-first");
    const oldest = oldestOnly[1000];
    if (!oldest) throw new Error("missing oldest run");
    const capped = fakeGitHub(oldestOnly, { [oldest.id]: [artifact(oldest.id, false)] });
    await expect(find(capped)).resolves.toEqual({ runId: oldest.id, missingReason: null });
    expect(capped.calls.some((call) => String(call.query.created).includes(".."))).toBe(true);

    const several = spreadPushes(2001, "oldest-first");
    const olderLive = several[999];
    const newestLive = several[2000];
    if (!olderLive || !newestLive) throw new Error("missing slice runs");
    const slices = fakeGitHub(several, {
      [olderLive.id]: [artifact(olderLive.id, false)],
      [newestLive.id]: [artifact(newestLive.id, false)],
    });
    await expect(find(slices)).resolves.toEqual({ runId: newestLive.id, missingReason: null });
    const created = slices.calls
      .filter((call) => call.pathname.endsWith("/runs"))
      .map((call) => String(call.query.created));
    expect(new Set(created).size).toBeGreaterThan(2);
  });

  it("counts a listed scoreboard-reports artifact even after it expires", async () => {
    const request = async (pathname: string, query: Record<string, string | number>) => {
      expect(pathname).toBe(`/repos/${REPOSITORY}/actions/runs/7/artifacts`);
      expect(query).toMatchObject({ name: "scoreboard-reports", per_page: 100 });
      return {
        artifacts: [{ name: "scoreboard-reports", expired: true }],
      };
    };
    await expect(
      reportsArtifactPresent({ repository: REPOSITORY, runId: 7, request }),
    ).resolves.toBe(true);
    await expect(
      reportsArtifactPresent({
        repository: REPOSITORY,
        runId: 8,
        request: async () => ({ artifacts: [] }),
      }),
    ).resolves.toBe(false);
  });

  it("labels a first run, an expired chain and a missing artifact truthfully", async () => {
    await expect(find(fakeGitHub([], {}))).resolves.toEqual({
      runId: null,
      missingReason: "first-run",
    });
    await expect(find(fakeGitHub([], {}), { indexJobPredates: () => true })).resolves.toEqual({
      runId: null,
      missingReason: "expired-after-90-days-inactivity",
    });
    await expect(
      find(fakeGitHub([run(5, "2026-07-01T00:00:00Z")], { 5: [artifact(5, true)] })),
    ).resolves.toEqual({ runId: null, missingReason: "expired-after-90-days-inactivity" });
    await expect(find(fakeGitHub([run(6, "2026-09-01T00:00:00Z")], {}))).resolves.toEqual({
      runId: null,
      missingReason: "prior-artifact-missing",
    });
    const predating = fakeGitHub([run(7, "2026-09-01T00:00:00Z")], { 7: [artifact(7, false)] });
    await expect(find(predating, { hasIndexJob: () => false })).resolves.toEqual({
      runId: null,
      missingReason: "first-run",
    });
    expect(predating.calls.some((call) => call.pathname.endsWith("/artifacts"))).toBe(false);
  });

  it("never restores from a fork branch named dev or a pull request run", async () => {
    const github = fakeGitHub(
      [
        run(40, "2026-09-20T00:00:00Z", {
          event: "pull_request",
          head_repository: { full_name: "someone/ardur-bot" },
        }),
        run(41, "2026-09-19T00:00:00Z", { head_repository: { full_name: "someone/ardur-bot" } }),
        run(42, "2026-09-18T00:00:00Z", { event: "pull_request" }),
      ],
      { 40: [artifact(40, false)], 41: [artifact(41, false)], 42: [artifact(42, false)] },
    );
    await expect(find(github)).resolves.toEqual({ runId: null, missingReason: "first-run" });
    expect(github.calls.some((call) => call.pathname.endsWith("/artifacts"))).toBe(false);
    expect(durableIndexScope({ eventName: "push", ref: "refs/heads/dev" })).toBe(true);
    expect(durableIndexScope({ eventName: "push", ref: "refs/heads/main" })).toBe(true);
    for (const scope of [
      { eventName: "pull_request", ref: "refs/pull/7/merge" },
      { eventName: "pull_request", ref: "refs/heads/dev" },
      { eventName: "workflow_dispatch", ref: "refs/heads/dev" },
      { eventName: "push", ref: "refs/heads/feature" },
      { eventName: "push", ref: "refs/tags/v1.0.0" },
    ])
      expect(durableIndexScope(scope)).toBe(false);
    const cli = spawnSync(process.execPath, ["scripts/scoreboard-index.mjs", "prior-index"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/7/merge",
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_API_URL: "http://127.0.0.1:9",
        GH_TOKEN: "",
      },
    });
    expect(cli.status).toBe(0);
    expect(cli.stdout.split("\n").filter(Boolean)).toEqual([
      "durable=false",
      "run_id=",
      "missing_reason=non-durable-check",
      "artifact_name=scoreboard-index-check",
    ]);
  });

  it("proves a first run from git history that predates the retention window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-history-"));
    try {
      fixtureGit(root, ["init", "-q", "-b", "dev"]);
      const old = await fixtureCommit(root, "README.md", "2026-01-01T00:00:00Z");
      const added = await fixtureCommit(
        root,
        "scripts/scoreboard-index.mjs",
        "2026-09-01T00:00:00Z",
      );
      const history = indexJobHistory(root);
      expect(history.hasIndexJob(old)).toBe(false);
      expect(history.hasIndexJob(added)).toBe(true);
      expect(history.indexJobPredates(new Date("2026-06-26T00:00:00.000Z"))).toBe(false);
      expect(history.indexJobPredates(new Date("2026-09-02T00:00:00.000Z"))).toBe(true);
      expect(history.hasIndexJob("not-a-commit")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("fixed release lookup", () => {
  it("picks the first-parent tag when a merged side branch tag is closer", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-describe-"));
    try {
      fixtureGit(root, ["init", "-q", "-b", "dev"]);
      await fixtureCommit(root, "base");
      fixtureGit(root, ["tag", "v1.0.0"]);
      await fixtureCommit(root, "main-1");
      fixtureGit(root, ["checkout", "-q", "-b", "side"]);
      await fixtureCommit(root, "side-1");
      fixtureGit(root, ["tag", "v9.0.0"]);
      await fixtureCommit(root, "side-2");
      fixtureGit(root, ["checkout", "-q", "dev"]);
      await fixtureCommit(root, "main-2");
      fixtureGit(root, ["merge", "--no-ff", "-q", "-m", "merge side", "side"]);
      await fixtureCommit(root, "release");
      const sha = fixtureGit(root, ["rev-parse", "HEAD"]);
      const described = spawnSync("git", fixedReleaseDescribeArgs(releaseYaml, sha), {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: os.devNull,
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      expect(described.status).toBe(0);
      expect(described.stdout.trim()).toBe("v1.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
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
    expect(releaseYaml).toContain("node scripts/release-publish.mjs");
    expect(releaseYaml).not.toContain("gh release create");
    const reports = performanceYaml.split("pattern: scoreboard-reports")[0]?.split("\n").slice(-12);
    expect(reports?.join("\n")).not.toContain("continue-on-error");
    expect(reports?.join("\n")).toContain("steps.reports.outputs.present == 'true'");
    expect(performanceYaml.indexOf("report-artifact")).toBeLessThan(
      performanceYaml.indexOf("pattern: scoreboard-reports"),
    );
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
    const noCleanup = goodRelease.replace(
      "node scripts/release-publish.mjs --waiver-record publication/scoreboard-publication/waiver-record.json",
      "true",
    );
    expect(() => assertWorkflowContracts(goodPerformance, noCleanup)).toThrow(/publish script/);
  });

  it("passes a waiver to the gate only from a manual dispatch", () => {
    const guarded = `\${{ github.event_name == 'workflow_dispatch' && inputs.evidence_waiver || '' }}`;
    const unguarded = goodRelease.replace(guarded, `\${{ inputs.evidence_waiver }}`);
    expect(() => assertWorkflowContracts(goodPerformance, unguarded)).toThrow(/waiver/);
    const unseen = goodPerformance.replace(`SCOREBOARD_WAIVER: \${{ inputs.evidence_waiver }}`, "");
    expect(() => assertWorkflowContracts(unseen, goodRelease)).toThrow(/waiver/);
    expect(releaseYaml).toContain(`evidence_waiver: ${guarded}`);
  });

  it("rejects an index lookup that trusts the newest run or uploads a check as durable", () => {
    const newest = goodPerformance.replace(
      "prior-index >>",
      "prior-index --jq '.workflow_runs[0].id' >>",
    );
    expect(() => assertWorkflowContracts(newest, goodRelease)).toThrow(/newest run/);
    const branch = goodPerformance.replace(
      'run: node scripts/scoreboard-index.mjs prior-index >> "$GITHUB_OUTPUT"',
      `run: gh api -f branch="\${{ github.head_ref }}"`,
    );
    expect(() => assertWorkflowContracts(branch, goodRelease)).toThrow(/prior-index/);
    const durable = goodPerformance.replace(
      `name: \${{ steps.prior.outputs.artifact_name }}`,
      "name: scoreboard-index",
    );
    expect(() => assertWorkflowContracts(durable, goodRelease)).toThrow(/artifact name/);
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
    expect(docs).toContain("Building the physical evidence runner is out of scope");
    expect(docs).toContain(
      "This preview was published without measured performance evidence: <reason>. Waived by <actor>.",
    );
    expect(docs).toContain(
      "retainedSessionGrowthBytes and toolTerminationDeadlineMs are still undeclared; publication needs them declared.",
    );
  });
});
