import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  judgeReport,
  metricBudget,
  reportRules,
} from "../packages/testkit/src/scoreboard/statistics.ts";
import { releaseNotes } from "./desktop-release.mjs";
import {
  appendIndexRecords,
  auditCommits,
  baselineMeasurementPlan,
  classifyGateCodes,
  durableIndexScope,
  findPriorIndexArtifact,
  gateErrorLine,
  INDEX_SCHEMA_VERSION,
  indexJobHistory,
  parseRevListParents,
  planEvidenceRecords,
  publicationFiles,
  RECORD_KEYS,
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
  stagePublicationReports,
  verifyPublicationBytes,
  WORKFLOW_ARTIFACT_RETENTION_DAYS,
} from "./scoreboard-index.mjs";

/** A single-record convenience wrapper the tests use; production code appends in batches. */
async function appendIndexRecord(
  root: string,
  input: Record<string, unknown>,
  options: Record<string, unknown> = {},
) {
  const { appended } = await appendIndexRecords(root, () => [input], options);
  return appended[0];
}

/** The single history/current-record view one test needs; production code audits by commit instead. */
function evidenceFor(
  records: {
    commit: string;
    suiteHash: string;
    environment: string;
    role: string;
    tier: string;
    status: string;
  }[],
  selector: { commit: string; suiteHash: string; environment: string; role: string; tier: string },
) {
  const history = records.filter(
    (record) =>
      record.commit === selector.commit &&
      record.suiteHash === selector.suiteHash &&
      record.environment === selector.environment &&
      record.role === selector.role &&
      record.tier === selector.tier,
  );
  const measured = history.filter((record) => record.status === "measured");
  const pending = history.filter((record) => record.status === "pending");
  return {
    history,
    current: measured.at(-1) ?? pending.at(-1) ?? null,
  };
}

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

const TIER_GUARDRAILS = {
  T1: new Set([
    "effect-safety",
    "deterministic-tasks",
    "recovery",
    "prompt-tokens",
    "cache-compaction",
  ]),
  T2: new Set(["latency", "absolute-targets", "bundle", "memory", "energy"]),
} as const;

function pinnedReleasePolicy() {
  const bytes = readFileSync(new URL("../docs/performance/release-policy.json", import.meta.url));
  return {
    bytes,
    policy: JSON.parse(bytes.toString("utf8")) as {
      budget: {
        required: {
          metricIds: string[];
          taskIds: string[];
          experimentIds: string[];
          crashBoundaryIds: string[];
          usage: boolean;
        };
        declarations: {
          nominalQueue: boolean;
          retainedSessionGrowthBytes: number | null;
          toolTerminationDeadlineMs: number | null;
        };
        seed: number;
        resamples: number;
      };
      guardrails: { id: string; metricIds: string[] }[];
    },
  };
}

function pinnedGuardrails() {
  return JSON.parse(
    readFileSync(new URL("../docs/performance/release-policy.json", import.meta.url), "utf8"),
  ).guardrails as {
    id: string;
    metricIds: string[];
    taskIds: string[];
    experimentIds: string[];
    crashBoundaryIds: string[];
    usage: boolean;
  }[];
}

function guardrailMetricIds(
  policy: ReturnType<typeof pinnedReleasePolicy>["policy"],
  tier: "T1" | "T2",
) {
  return [
    ...new Set(
      policy.guardrails
        .filter((guardrail) => TIER_GUARDRAILS[tier].has(guardrail.id))
        .flatMap((guardrail) => guardrail.metricIds),
    ),
  ];
}

function metricFixtureValue(id: string) {
  if (id.startsWith("m13.") || id === "m11.lazy-boundary-violations") return 0;
  return 1;
}

function fillMetric(report: ReturnType<typeof syntheticReport>, id: string, count: number) {
  const metric = report.metrics.find((item) => item.id === id);
  if (!metric) throw new Error(`missing metric ${id}`);
  metric.missingReason = null;
  metric.applicability = "applicable";
  metric.coverage = { expected: count, observed: count };
  metric.observations = Array.from({ length: count }, (_, index) => ({
    id: `obs-${id.replaceAll(".", "-")}-${index}`,
    sessionId: `session-${index}`,
    pairId: `pair-${index}`,
    traceId: "trace-01",
    outcome: "success" as const,
    value: metricFixtureValue(id),
    missingReason: null,
    provenance: { kind: "measured" as const, sourceHash: hash("raw") },
  }));
}

function usageRequest() {
  const category = (value: number) => ({
    value,
    missingReason: null,
    provenance: { kind: "counted" as const, sourceHash: hash("raw") },
  });
  return {
    requestId: "request-01",
    turnId: "turn-01",
    attemptId: "attempt-01",
    parentRequestId: null,
    purpose: "main" as const,
    routeId: "route-01",
    traceId: "trace-01",
    outcome: "success" as const,
    inputSemantics: "total-with-cache-subsets" as const,
    reasoningSemantics: "subset-of-output" as const,
    requestHash: hash("request"),
    usageRequestHash: hash("request"),
    counter: { mode: "request-delta" as const, epochId: "epoch-01", sequence: 0 },
    categories: {
      logicalInput: category(100),
      uncachedInput: category(60),
      cacheReadInput: category(30),
      cacheWriteInput: category(10),
      output: category(50),
      reasoning: category(20),
    },
  };
}

/** Real pinned policy, T2 parent/candidate/fixed-release, and a T1 candidate-crash.json. */
async function documentedPinnedRelease() {
  const staged = await writeReleaseCase(
    SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum,
    true,
  );
  const pinned = pinnedReleasePolicy();
  await writeFile(path.join(staged.root, "release-policy.json"), pinned.bytes);
  const startupPairs = SCOREBOARD_MANIFEST.samplePlan.releaseStartupObservationsPerStratum;
  const t2Ids = guardrailMetricIds(pinned.policy, "T2");
  const names = ["parent.json", "candidate.json", "fixed-release.json"] as const;
  const written = new Map<string, ReturnType<typeof syntheticReport>>();
  for (const name of names) {
    const envelope = JSON.parse(await readFile(path.join(staged.reportsRoot, name), "utf8")) as {
      report: ReturnType<typeof syntheticReport>;
    };
    const report = envelope.report;
    report.scenario.tier = "T2";
    for (const id of t2Ids) fillMetric(report, id, startupPairs);
    written.set(name, report);
    const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(report));
    await writeFile(path.join(staged.reportsRoot, name), bytes);
    if (name === "candidate.json")
      await writeFile(path.join(staged.artifactRoot, "scoreboard-candidate.json"), bytes);
  }
  const parent = written.get("parent.json")!;
  const calibrationA = structuredClone(parent);
  calibrationA.id = "calibration-a";
  calibrationA.createdAt = "2026-01-01T00:00:00.000Z";
  const calibrationB = structuredClone(calibrationA);
  calibrationB.id = "calibration-b";
  calibrationB.createdAt = "2026-01-02T00:00:00.000Z";
  const evidencePolicy = createBudgetPolicy(pinned.policy.budget.required, {
    mode: "release",
    environmentHash: parent.environmentHash,
    scenario: parent.scenario,
    seed: pinned.policy.budget.seed,
    resamples: pinned.policy.budget.resamples,
    ...pinned.policy.budget.declarations,
  });
  evidencePolicy.policy.calibration = {
    frozenAt: "2026-01-03T00:00:00.000Z",
    reports: [
      createPerformanceEvidenceEnvelope(calibrationA),
      createPerformanceEvidenceEnvelope(calibrationB),
    ],
  };
  evidencePolicy.sha256 = contentDigest(evidencePolicy.policy);
  await writeFile(path.join(staged.reportsRoot, "policy.json"), JSON.stringify(evidencePolicy));
  const crash = structuredClone(written.get("candidate.json")!);
  crash.id = "candidate-crash-report";
  crash.scenario.tier = "T1";
  for (const id of guardrailMetricIds(pinned.policy, "T1")) {
    if (id === "m05.cache-token-hit" || id === "m05.cache-request-hit") continue;
    fillMetric(crash, id, 1);
  }
  for (const crashRow of crash.crashes) {
    const expected = CRASH_BOUNDARIES.find((boundary) => boundary.id === crashRow.id)!.expected;
    crashRow.status = "complete";
    crashRow.missingReason = null;
    crashRow.recovery = expected;
    crashRow.safetyPassed = true;
    crashRow.taskCompleted = expected !== "explicit-uncertainty";
    crashRow.traceIds = ["trace-01"];
  }
  for (const task of crash.tasks) {
    task.status = "complete";
    task.missingReason = null;
    task.fixtureHash = hash("fixture");
    task.graderHash = hash("grader");
    task.trials = [
      {
        id: `trial-${task.id}`,
        sessionId: "session-1",
        pairId: `pair-${task.id}`,
        traceId: "trace-01",
        outcome: "success",
        passed: true,
        criticalPassed: true,
        withinDeadline: true,
      },
    ];
  }
  crash.usage = [usageRequest()];
  crash.usageCoverage = { expected: 1, observed: 1 };
  const crashBytes = JSON.stringify(createPerformanceEvidenceEnvelope(crash));
  await writeFile(path.join(staged.reportsRoot, "candidate-crash.json"), crashBytes);
  await writeFile(path.join(staged.artifactRoot, "scoreboard-candidate-crash.json"), crashBytes);
  return staged;
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
    expect(WORKFLOW_ARTIFACT_RETENTION_DAYS).toBe(90);
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

  it("pins the record schema's key set and canonical hash to this INDEX_SCHEMA_VERSION", async () => {
    expect(INDEX_SCHEMA_VERSION).toBe(7);
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-golden-"));
    try {
      // Built through the real record builder (appendIndexRecords/normalizeRecord), not a
      // hand-made object, so a key added to or removed from the real record shape shows up here
      // without a matching edit to this fixture.
      const record = await appendIndexRecord(root, {
        status: "measured",
        tier: "release",
        mode: "release",
        commit: A,
        parentCommit: B,
        fixedReleaseCommit: C,
        suiteVersion: SCOREBOARD_MANIFEST.suiteVersion,
        environment: "release-packaged",
        environmentHash: hash("environment"),
        attempt: 1,
        role: "candidate",
        indexedAt: "2026-09-25T00:00:00.000Z",
        runnerCommit: A,
        supersedes: null,
        metricIds: [],
        verdictDigest: hash("verdict"),
        artifactDigests: [
          {
            name: "synthetic.dmg",
            sha256: hash("build"),
            bytes: 1,
            target: "desktop-darwin-arm64",
          },
        ],
        envelope: syntheticReport(1, "golden-report"),
      });
      const { recordHash, ...body } = record;
      expect(Object.keys(body).sort()).toEqual([...RECORD_KEYS].sort());

      // The pinned hash below is a tripwire for a change to the record's key set or its canonical
      // serialization — whether or not it comes with an INDEX_SCHEMA_VERSION bump; it does not
      // itself enforce that a bump happens. Every field here is a fixed literal, including the
      // ones the real record above derives from the manifest (suiteHash, declaredSamples,
      // samplePlan) or from the synthetic report fixture (reportDigest, objectDigest). So editing
      // a metric definition or sample plan in packages/testkit/src/scoreboard/manifest.ts, or
      // changing the syntheticReport fixture, cannot move this hash: only a change to the
      // record's shape or contentDigest's serialization can.
      const golden = {
        schemaVersion: 7,
        status: "measured",
        tier: "release",
        commit: A,
        parentCommit: B,
        fixedReleaseCommit: C,
        suiteVersion: "golden-suite-version",
        suiteHash: hash("golden-suite-hash"),
        environment: "release-packaged",
        environmentHash: hash("environment"),
        attempt: 1,
        role: "candidate",
        indexedAt: "2026-09-25T00:00:00.000Z",
        runnerCommit: A,
        samplePlan: "golden-sample-plan",
        declaredSamples: { pairs: 200, startupPerStratum: 100 },
        observedSamples: 1,
        reportDigest: hash("golden-report-digest"),
        objectDigest: hash("golden-object-digest"),
        verdictDigest: hash("verdict"),
        artifactDigests: [
          {
            name: "synthetic.dmg",
            sha256: hash("build"),
            bytes: 1,
            target: "desktop-darwin-arm64",
          },
        ],
        pendingReason: null,
        gateCodes: [],
        supersedes: null,
        chainOrigin: "first-run",
        enumerationStart: null,
        enumerationReason: null,
        waiver: null,
        metricIds: [],
        previousHash: "0".repeat(64),
      };
      expect(Object.keys(golden).sort()).toEqual([...RECORD_KEYS].sort());
      expect(contentDigest(golden)).toBe(
        "0fa957e6c9a1d63e5dc77fb0c764d4e3969e7bdd96cd08da3bc6125256b5f811",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans a record for every enumerated commit, only-headCommit attempted", () => {
    const planned = planEvidenceRecords({
      commits: [
        { commit: A, parentCommit: null },
        { commit: B, parentCommit: A },
      ],
      pendingReason: "schema-3-evidence-not-produced",
      headCommit: B,
    });
    expect(planned.map((item) => [item.commit, item.pendingReason])).toEqual([
      [A, "not-measured"],
      [B, "schema-3-evidence-not-produced"],
    ]);
    expect(parseRevListParents(`${B} ${A} ${C}\n${A}\n`)).toEqual([
      { commit: B, parentCommit: A },
      { commit: A, parentCommit: null },
    ]);
    expect(selectCommitRange({ base: B, head: A })).toEqual({ kind: "range", base: B, head: A });
    expect(selectCommitRange({ base: "0".repeat(40), head: A })).toEqual({
      kind: "single",
      head: A,
    });
    expect(selectCommitRange({ head: A })).toEqual({ kind: "single", head: A });
    expect(() => selectCommitRange({ base: "main", head: A })).toThrow();
  });

  it("never measures a baseline without a compatible in-tree harness", () => {
    expect(
      baselineMeasurementPlan({
        baseHarnessPresent: false,
        candidateSha: A,
        baseSha: B,
      }),
    ).toEqual({
      measureBaseline: false,
      pendingReason: "benchmark-runner-incompatible",
    });
    expect(
      baselineMeasurementPlan({
        baseHarnessPresent: true,
        candidateSha: C,
        baseSha: B,
      }),
    ).toEqual({ measureBaseline: true, pendingReason: null });
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

  it("times out on a held lock; no writer runs concurrently in production", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-lock-"));
    try {
      await mkdir(path.join(root, "lock"));
      await expect(appendIndexRecord(root, pending(A), { timeoutMs: 80 })).rejects.toMatchObject({
        code: "lock-timeout",
      });
      await rm(path.join(root, "lock"), { recursive: true, force: true });
      await expect(appendIndexRecord(root, pending(A), { timeoutMs: 1000 })).resolves.toMatchObject(
        { commit: A },
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

  it("refuses an index record from any other schema version with a plain error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-schema-"));
    try {
      const current: Record<string, unknown> = { ...(await appendIndexRecord(root, pending(A))) };
      expect(current.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
      const resign = (record: Record<string, unknown>) => {
        const unsigned = { ...record };
        delete unsigned.recordHash;
        return { ...unsigned, recordHash: contentDigest(unsigned) };
      };
      const older = { ...current, schemaVersion: INDEX_SCHEMA_VERSION - 1 };
      delete older.enumerationStart;
      delete older.enumerationReason;
      const newer = { ...current, schemaVersion: INDEX_SCHEMA_VERSION + 1 };
      for (const record of [resign(older), resign(newer)]) {
        await writeFile(path.join(root, "records.jsonl"), `${JSON.stringify(record)}\n`);
        await expect(readIndex(root)).rejects.toMatchObject({
          code: "unsupported-index-schema",
          message: `Index records must use schema version ${INDEX_SCHEMA_VERSION}.`,
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a chain from an older record schema as a fresh schema-upgrade chain", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-schema-upgrade-"));
    const source = path.join(root, "source");
    const target = path.join(root, "target");
    try {
      const current: Record<string, unknown> = { ...(await appendIndexRecord(source, pending(A))) };
      const older = { ...current, schemaVersion: INDEX_SCHEMA_VERSION - 1 };
      delete older.enumerationStart;
      delete older.enumerationReason;
      delete older.recordHash;
      const resigned = { ...older, recordHash: contentDigest(older) };
      await writeFile(path.join(source, "records.jsonl"), `${JSON.stringify(resigned)}\n`);

      const origin = await restoreIndex(source, target, null);
      expect(origin).toBe("schema-upgrade");
      expect(await readIndex(target)).toEqual([]);
      expect((await readFile(path.join(target, ".chain-origin"), "utf8")).trim()).toBe(
        "schema-upgrade",
      );
      const appended = await appendIndexRecord(target, pending(B));
      expect(appended.chainOrigin).toBe("schema-upgrade");
      expect(appended.previousHash).toBe("0".repeat(64));
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
      // A restored chain that fails verification never blocks the job: it starts a fresh chain
      // instead, and warns naming the failure code, the artifact, and the run that uploaded it.
      const recovered = spawnSync(
        process.execPath,
        [
          "scripts/scoreboard-index.mjs",
          "restore-index",
          "--source",
          broken,
          "--root",
          path.join(root, "recovered"),
          "--missing-reason",
          "expired-after-90-days-inactivity",
          "--artifact",
          "scoreboard-index-schema-7",
          "--run-id",
          "4242",
        ],
        { cwd: repo, encoding: "utf8" },
      );
      expect(recovered.status).toBe(0);
      expect(recovered.stdout).toContain("::warning title=Scoreboard index::");
      expect(recovered.stdout).toContain("corrupt-index");
      expect(recovered.stdout).toContain("scoreboard-index-schema-7");
      expect(recovered.stdout).toContain("run 4242");
      expect((await readIndex(path.join(root, "recovered"))).length).toBe(0);
      expect((await readFile(path.join(root, "recovered", ".chain-origin"), "utf8")).trim()).toBe(
        "restore-failed",
      );
      const third = await appendIndexRecord(path.join(root, "recovered"), pending(D));
      expect(third.chainOrigin).toBe("restore-failed");
      expect(third.previousHash).toBe("0".repeat(64));

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
    const notes = await releaseNotes(
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

  async function refreezeStartupPolicy(reportsRoot: string) {
    const candidate = JSON.parse(await readFile(path.join(reportsRoot, "candidate.json"), "utf8"))
      .report as ReturnType<typeof syntheticReport>;
    const proposed = createBudgetPolicy(
      {
        metricIds: ["m13.wrong-pin"],
        taskIds: [],
        experimentIds: [],
        crashBoundaryIds: [],
        usage: false,
      },
      {
        mode: "release",
        environmentHash: candidate.environmentHash,
        scenario: candidate.scenario,
      },
    );
    const calibrationA = structuredClone(candidate);
    calibrationA.id = "calibration-a";
    calibrationA.createdAt = "2026-01-01T00:00:00.000Z";
    const calibrationB = structuredClone(calibrationA);
    calibrationB.id = "calibration-b";
    calibrationB.createdAt = "2026-01-02T00:00:00.000Z";
    await writeFile(
      path.join(reportsRoot, "policy.json"),
      JSON.stringify(
        freezeBudgetPolicy(
          proposed,
          [
            createPerformanceEvidenceEnvelope(calibrationA),
            createPerformanceEvidenceEnvelope(calibrationB),
          ],
          "2026-01-03T00:00:00.000Z",
        ),
      ),
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

  it("gates the flat publication/release-ready layout with real installer names", async () => {
    const probe = await stagePassing();
    try {
      await rm(probe.artifactRoot, { recursive: true, force: true });
      await mkdir(probe.artifactRoot, { recursive: true });
      const version = "0.1.0-alpha.1";
      const flatFiles = [
        { name: `ardur-bot-${version}-mac-arm64.dmg`, target: "desktop-darwin-arm64" },
        { name: `ardur-bot-${version}-mac-x64.dmg`, target: "desktop-darwin-x64" },
        { name: `ardur-bot-${version}-linux-x64.AppImage`, target: "desktop-linux-x64" },
        { name: `ardur-bot-${version}-win-x64.exe`, target: "desktop-win32-x64" },
      ] as const;
      const files: { target: string; name: string; sha256: string; bytes: number }[] = [];
      for (const { name, target } of flatFiles) {
        const body = Buffer.from(`installer-${target}`);
        await writeFile(path.join(probe.artifactRoot, name), body);
        files.push({
          target,
          name,
          sha256: createHash("sha256").update(body).digest("hex"),
          bytes: body.length,
        });
      }
      await rewriteCandidate(probe.reportsRoot, (report) => {
        report.artifacts = [
          ...report.artifacts.filter((artifact) => artifact.kind !== "build"),
          ...files.map((file) => ({
            sha256: file.sha256,
            bytes: file.bytes,
            kind: "build" as const,
          })),
        ];
      });
      for (const file of files)
        await rebindEnergy(probe.reportsRoot, file.target, file.sha256, platformFor(file.target));
      const result = await gate(probe, "index-flat-layout");
      expect(result.code).toBe(0);
      expect(result.gate.allowPublication).toBe(true);
      expect(
        result.gate.distributedDigests.map((file: { name: string }) => file.name).sort(),
      ).toEqual([...flatFiles.map((file) => file.name), "scoreboard-candidate.json"].sort());
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
      stdout: result.stdout,
      gate: JSON.parse(readFileSync(outputPath, "utf8")),
      indexRoot: path.join(caseRoot.root, indexName),
    };
  }

  it("reports only reports-missing, no digest mismatch, and exits 2 with no evidence at all", async () => {
    const bare = await stageWithoutEvidence();
    try {
      const result = await gate(bare, "index-bare");
      expect(result.code).toBe(2);
      expect(result.gate.allowPublication).toBe(false);
      expect(codes(result.gate)).toEqual(["reports-missing"]);
      expect(result.gate.reasons[0]?.detail).toContain(
        "No measured evidence exists for this release.",
      );
      const records = await readIndex(result.indexRoot);
      expect(records.map((record) => [record.status, record.pendingReason])).toEqual([
        ["pending", "reports-missing"],
      ]);
      expect(() => renderScoreboardNotes(result.gate)).toThrow();
    } finally {
      await rm(bare.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("names the missing reports without waiver advice when only some reports are missing", async () => {
    const partial = await stagePassing();
    try {
      for (const name of ["parent.json", "fixed-release.json", "policy.json"])
        await rm(path.join(partial.reportsRoot, name));
      const result = await gate(partial, "index-partial");
      expect(result.code).toBe(2);
      expect(result.gate.allowPublication).toBe(false);
      expect(codes(result.gate)).toEqual(["reports-missing"]);
      const detail = result.gate.reasons[0]?.detail as string;
      expect(detail).toContain("parent.json");
      expect(detail).toContain("fixed-release.json");
      expect(detail).toContain("policy.json");
      expect(detail).not.toContain("candidate.json");
      expect(detail).not.toContain("No measured evidence exists for this release.");
      expect(detail).not.toContain("evidence_waiver");
      // The sentence ends with an action, not a restatement of the same fact.
      expect(detail).not.toContain("Every report is required");
      expect(detail).toContain(
        "Upload parent.json, fixed-release.json and policy.json with the other reports and run the release again.",
      );
      const records = await readIndex(result.indexRoot);
      expect(records.map((record) => [record.status, record.pendingReason])).toEqual([
        ["pending", "reports-missing"],
      ]);
    } finally {
      await rm(partial.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("names an unreadable report as unreadable rather than as not uploaded", async () => {
    const malformed = await stagePassing();
    try {
      await writeFile(path.join(malformed.reportsRoot, "parent.json"), "{not json");
      const result = await gate(malformed, "index-malformed-parent");
      expect(result.code).toBe(2);
      expect(result.gate.allowPublication).toBe(false);
      expect(codes(result.gate)).toEqual(["reports-missing"]);
      const detail = result.gate.reasons[0]?.detail as string;
      expect(detail).toContain("parent.json could not be read");
      expect(detail).toContain("Fix or re-upload it and run the release again.");
      expect(detail).not.toContain("did not upload");
      expect(detail).not.toContain("No measured evidence exists for this release.");
      expect(detail).not.toContain("evidence_waiver");
      const records = await readIndex(result.indexRoot);
      expect(records.map((record) => [record.status, record.pendingReason])).toEqual([
        ["pending", "reports-missing"],
      ]);
    } finally {
      await rm(malformed.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("never offers the waiver when all four reports are absent but the folder isn't empty", async () => {
    const bare = await stageWithoutEvidence();
    try {
      await writeFile(path.join(bare.reportsRoot, "notes.txt"), "not a report");
      const result = await gate(bare, "index-stray-file");
      expect(result.code).toBe(2);
      expect(result.gate.allowPublication).toBe(false);
      expect(codes(result.gate)).toEqual(["reports-missing"]);
      const detail = result.gate.reasons[0]?.detail as string;
      expect(detail).toContain("parent.json");
      expect(detail).toContain("candidate.json");
      expect(detail).toContain("fixed-release.json");
      expect(detail).toContain("policy.json");
      expect(detail).not.toContain("No measured evidence exists for this release.");
      expect(detail).not.toContain("evidence_waiver");
      const records = await readIndex(result.indexRoot);
      expect(records.map((record) => [record.status, record.pendingReason])).toEqual([
        ["pending", "reports-missing"],
      ]);
    } finally {
      await rm(bare.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("prints every refusal reason as a job-log error line, and the allowed waiver characters", async () => {
    const bare = await stageWithoutEvidence();
    try {
      const missing = releaseGateCli(bare, {}, "index-error-lines");
      expect(missing.status).not.toBe(0);
      expect(missing.stdout).toContain("::error title=Scoreboard release gate::");
      for (const reason of missing.gate.reasons as { code: string; detail?: string }[]) {
        const expected =
          reason.detail && reason.detail !== reason.code
            ? reason.detail
            : reason.code.replaceAll("-", " ");
        expect(missing.stdout, JSON.stringify(reason)).toContain(expected);
      }
      // `reports-missing` names today's working path, not the generic "refused this run" wrapper.
      expect(missing.stdout).toContain(
        "No measured evidence exists for this release. To publish a preview now, run the release " +
          "workflow by hand with an evidence_waiver reason.",
      );
      expect(missing.stdout).not.toContain("refused this run: No measured evidence");

      const badWaiver = releaseGateCli(
        bare,
        { SCOREBOARD_WAIVER: "Ask ops@example.invalid", GITHUB_EVENT_NAME: "workflow_dispatch" },
        "index-error-waiver",
      );
      expect(badWaiver.status).not.toBe(0);
      expect(codes(badWaiver.gate)).toEqual(["invalid-waiver"]);
      expect(badWaiver.stdout).toContain("::error title=Scoreboard release gate::");
      expect(badWaiver.stdout).toContain("letters, numbers, spaces");
      expect(badWaiver.stdout).toContain("www.");
    } finally {
      await rm(bare.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("prints a non-blocking undeclared budget as its own plain sentence, not a refusal", () => {
    const line = gateErrorLine({
      code: "undeclared-budget",
      scope: "candidate:m13.terminal-stop",
      detail: "The tool termination deadline budget is not declared.",
    });
    expect(line).toBe("The tool termination deadline budget is not declared.");
    expect(line).not.toContain("refused this run");
    expect(line).not.toContain("candidate:m13.terminal-stop");
  });

  it("prints a blocking undeclared budget with the action to declare it", () => {
    const line = gateErrorLine({
      code: "undeclared-budget",
      scope: "candidate:m13.terminal-stop",
      detail: "The tool termination deadline budget is not declared.",
      blocks: true,
    });
    expect(line).toContain("The tool termination deadline budget is not declared.");
    expect(line).toContain("Declare that budget in the release policy");
    expect(line).not.toContain("candidate:m13.terminal-stop");
  });

  it("prints a non-blocking undeclared budget as a warning beside a real error", async () => {
    const tiered = await stagePassing();
    try {
      for (const name of ["parent.json", "candidate.json", "fixed-release.json"]) {
        const file = path.join(tiered.reportsRoot, name);
        const envelope = JSON.parse(await readFile(file, "utf8")) as {
          report: ReturnType<typeof syntheticReport>;
        };
        envelope.report.scenario.tier = "T2";
        const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report));
        await writeFile(file, bytes);
        if (name === "candidate.json")
          await writeFile(path.join(tiered.artifactRoot, "scoreboard-candidate.json"), bytes);
      }
      const candidateReport = JSON.parse(
        await readFile(path.join(tiered.reportsRoot, "candidate.json"), "utf8"),
      ).report as ReturnType<typeof syntheticReport>;
      // The committed release policy's real T2 guardrails ("memory", "absolute-targets") already
      // cover these two metric ids with a null declaration each; a comparison that requires them
      // and is tiered by report leaves them undeclared but never blocks on them. `m01.acknowledgement`
      // keeps the derived policy's required selection non-empty without adding a declared budget
      // this fixture's reports would fail.
      const submittedPolicy = createBudgetPolicy(
        {
          metricIds: ["m10.post-idle-retained", "m13.terminal-stop", "m01.acknowledgement"],
          taskIds: [],
          experimentIds: [],
          crashBoundaryIds: ["crash-01"],
          usage: false,
        },
        {
          mode: "release",
          environmentHash: candidateReport.environmentHash,
          scenario: candidateReport.scenario,
          nominalQueue: false,
          retainedSessionGrowthBytes: null,
          toolTerminationDeadlineMs: null,
        },
      );
      await writeFile(
        path.join(tiered.reportsRoot, "policy.json"),
        JSON.stringify(submittedPolicy),
      );
      const result = releaseGateCli(tiered, {}, "index-tiered-undeclared");
      expect(result.status).not.toBe(0);
      const reasons = result.gate.reasons as { code: string; blocks?: boolean }[];
      const undeclared = reasons.filter((reason) => reason.code === "undeclared-budget");
      expect(undeclared.length).toBeGreaterThan(0);
      expect(undeclared.every((reason) => reason.blocks === false)).toBe(true);
      expect(reasons.some((reason) => reason.code !== "undeclared-budget")).toBe(true);
      expect(result.stdout).toContain("::error title=Scoreboard release gate::");
      expect(result.stdout).toContain(
        "::warning title=Scoreboard release gate::The tool termination deadline budget is not declared.",
      );
      expect(result.stdout).not.toContain(
        "::error title=Scoreboard release gate::The tool termination deadline budget is not declared.",
      );
    } finally {
      await rm(tiered.root, { recursive: true, force: true });
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
        waiver: { reason: WAIVER },
      });
      expect(JSON.stringify(result.gate)).not.toContain("release-operator");
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
      const notes = await releaseNotes(["feat: fixture"], result.gate);
      const evidence = notes.split("## Performance evidence\n\n")[1] ?? "";
      expect(evidence.split("\n")[0]).toBe(
        `This preview was published without measured performance evidence: ${WAIVER}.`,
      );
      const waiverText = await readFile(path.join(bare.root, "waiver-record.json"), "utf8");
      expect(JSON.parse(waiverText)).toEqual({
        reason: WAIVER,
        runId: 5150,
        indexLine: 1,
        recordHash: records[0]?.recordHash,
      });
      for (const text of [notes, waiverText, JSON.stringify(result.gate)])
        expect(text).not.toContain("release-operator");
      expect(notes).not.toMatch(
        /Measured evidence|\| Metric|Observed samples|within-budget|Waived by/,
      );
    } finally {
      await rm(bare.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("still publishes under a waiver after the release chain is restored from an older schema", async () => {
    const bare = await stageWithoutEvidence();
    try {
      const source = path.join(bare.root, "old-schema-source");
      const target = path.join(bare.root, "index-schema-waiver");
      const current: Record<string, unknown> = { ...(await appendIndexRecord(source, pending(A))) };
      const older = { ...current, schemaVersion: INDEX_SCHEMA_VERSION - 1 };
      delete older.enumerationStart;
      delete older.enumerationReason;
      delete older.recordHash;
      const resigned = { ...older, recordHash: contentDigest(older) };
      await writeFile(path.join(source, "records.jsonl"), `${JSON.stringify(resigned)}\n`);
      expect(await restoreIndex(source, target, null)).toBe("schema-upgrade");

      const result = await gate(bare, "index-schema-waiver", {
        waiver: WAIVER,
        trigger: "workflow_dispatch",
        actor: "release-operator",
      });
      expect(result.code).toBe(0);
      expect(result.gate.allowPublication).toBe(true);
      const records = await readIndex(result.indexRoot);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ status: "waived", chainOrigin: "schema-upgrade" });
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
        "Ask ops@example.invalid",
        "See [notes](https://example.invalid)",
        "Mirror at https://user:token@192.0.2.1/builds",
        "Runner logs are in /opt/runner/logs",
        "Output kept under ./build/cache",
        "Notes at ~/lab",
        "See example.com/runbook",
        "Runbook at www.example.com/perf",
        "apps/desktop/out",
        "first line\nsecond line",
        "x".repeat(201),
      ];
      for (const [index, waiver] of unsafe.entries()) {
        const result = await gate(bare, `index-invalid-${index}`, {
          waiver,
          trigger: "workflow_dispatch",
          actor: "release-operator",
        });
        expect(result.code, waiver).toBe(1);
        expect(codes(result.gate), waiver).toEqual(["invalid-waiver"]);
        const edited = {
          schemaVersion: INDEX_SCHEMA_VERSION,
          path: "waiver",
          allowPublication: true,
          exitCode: 0,
          reasons: [],
          waiver: { reason: waiver },
          distributedDigests: [],
        };
        expect(() => renderScoreboardNotes(edited), waiver).toThrow();
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

  it("refuses a waiver whenever the reports folder has any entry, nested or oddly named", async () => {
    const bare = await stageWithoutEvidence();
    try {
      await mkdir(path.join(bare.reportsRoot, "nested"), { recursive: true });
      await writeFile(path.join(bare.reportsRoot, "nested", "candidate.json"), "{}");
      // No well-known top-level file name and no environment variable is needed: any entry at all
      // in the reports directory refuses the waiver.
      const guarded = await gate(bare, "index-waiver-guarded", {
        waiver: WAIVER,
        trigger: "workflow_dispatch",
        actor: "release-operator",
      });
      expect(guarded.code).not.toBe(0);
      expect(codes(guarded.gate)).toEqual(["waiver-with-evidence"]);
      expect(
        (await readIndex(guarded.indexRoot)).some((record) =>
          ["measured", "waived"].includes(record.status),
        ),
      ).toBe(false);
    } finally {
      await rm(bare.root, { recursive: true, force: true });
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
      // This comparison is not tiered by report (crashBoundaryIds is empty), so both budgets
      // block the run: `blocks: true` is what tells the CLI to print them as errors, not
      // warnings, and to add the "declare it" action.
      for (const detail of [
        "The retained session growth budget is not declared.",
        "The tool termination deadline budget is not declared.",
      ])
        expect(result.gate.reasons).toContainEqual(
          expect.objectContaining({ code: "undeclared-budget", detail, blocks: true }),
        );
      expect(JSON.stringify(result.gate)).not.toMatch(
        /retainedSessionGrowthBytes|toolTerminationDeadlineMs/,
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
          detail: "missing T1 durable crash report: candidate-crash.json",
        }),
      ]);
    } finally {
      await rm(paired.root, { recursive: true, force: true });
      await rm(startupOnly.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("publishes a documented T2 trio beside the T1 crash report under the pinned policy", async () => {
    const pinned = pinnedReleasePolicy();
    expect(createHash("sha256").update(pinned.bytes).digest("hex")).toBe(RELEASE_POLICY_SHA256);
    const probe = await documentedPinnedRelease();
    try {
      const result = await gate(probe, "index-pinned-tiers");
      expect(result.code).toBe(0);
      expect(result.gate.allowPublication).toBe(true);
      expect(result.gate.releaseEligible).toBe(true);
      expect(codes(result.gate)).not.toContain("invalid-policy");
      expect(codes(result.gate)).not.toContain("incomplete-evidence");
      expect(codes(result.gate)).not.toContain("mandatory-evidence-unknown");
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("names the missing T1 crash report and refuses a short T2 startup floor", async () => {
    const missing = await documentedPinnedRelease();
    const shortStartup = await documentedPinnedRelease();
    try {
      await rm(path.join(missing.reportsRoot, "candidate-crash.json"));
      await rm(path.join(missing.artifactRoot, "scoreboard-candidate-crash.json"));
      const withoutCrash = await gate(missing, "index-pinned-no-crash");
      expect(withoutCrash.gate.allowPublication).toBe(false);
      expect(withoutCrash.gate.reasons).toContainEqual(
        expect.objectContaining({
          code: "mandatory-evidence-unknown",
          scope: "recovery",
          detail: expect.stringContaining("candidate-crash.json"),
        }),
      );

      const candidatePath = path.join(shortStartup.reportsRoot, "candidate.json");
      const envelope = JSON.parse(await readFile(candidatePath, "utf8")) as {
        report: ReturnType<typeof syntheticReport>;
      };
      for (const metric of envelope.report.metrics) {
        if (!metric.id.startsWith("m09.")) continue;
        metric.observations = metric.observations.filter((observation) => {
          const pairId = observation.pairId ?? "";
          if (!pairId.startsWith("process-cold-os-warm-")) return true;
          return Number(pairId.slice("process-cold-os-warm-".length)) < 10;
        });
        metric.coverage = {
          expected: metric.observations.length,
          observed: metric.observations.length,
        };
      }
      const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report));
      await writeFile(candidatePath, bytes);
      await writeFile(path.join(shortStartup.artifactRoot, "scoreboard-candidate.json"), bytes);
      const refused = await gate(shortStartup, "index-pinned-short-startup");
      expect(refused.code).not.toBe(0);
      expect(refused.gate.allowPublication).toBe(false);
      expect(codes(refused.gate)).toContain("insufficient-startup-samples");
      expect(codes(refused.gate)).not.toContain("incomplete-evidence");
      expect(codes(refused.gate)).not.toContain("mandatory-evidence-unknown");
    } finally {
      await rm(missing.root, { recursive: true, force: true });
      await rm(shortStartup.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("renders recovery and tasks from the T1 crash report and publishes both reports", async () => {
    const paired = await stagePassing();
    try {
      await setStartupTier(paired);
      await refreezeStartupPolicy(paired.reportsRoot);
      await writeCandidateCrashReport(paired.reportsRoot);
      const crashPath = path.join(paired.reportsRoot, "candidate-crash.json");
      const crashEnvelope = JSON.parse(await readFile(crashPath, "utf8")) as {
        report: ReturnType<typeof syntheticReport>;
      };
      for (const task of crashEnvelope.report.tasks) {
        task.status = "complete";
        task.missingReason = null;
        task.fixtureHash = hash("fixture");
        task.graderHash = hash("grader");
        task.trials = [
          {
            id: `trial-${task.id}`,
            sessionId: "session-1",
            pairId: `pair-${task.id}`,
            traceId: "trace-01",
            outcome: "success",
            passed: true,
            criticalPassed: true,
            withinDeadline: true,
          },
        ];
      }
      const crashBytes = JSON.stringify(createPerformanceEvidenceEnvelope(crashEnvelope.report));
      await writeFile(crashPath, crashBytes);
      await writeFile(
        path.join(paired.artifactRoot, "scoreboard-candidate-crash.json"),
        crashBytes,
      );
      const policy = fixtureReleasePolicy();
      await writeReleasePolicy(paired.root, {
        ...policy,
        guardrails: [
          ...policy.guardrails,
          {
            id: "recovery",
            metricIds: [],
            taskIds: [],
            experimentIds: [],
            crashBoundaryIds: CRASH_BOUNDARIES.map((boundary) => boundary.id),
            usage: false,
          },
          {
            id: "deterministic-tasks",
            metricIds: [],
            taskIds: TASK_DEFINITIONS.map((task) => task.id),
            experimentIds: [],
            crashBoundaryIds: [],
            usage: false,
          },
        ],
      });
      const result = await gate(paired, "index-evidence-notes");
      expect(result.code).toBe(0);
      const notes = await releaseNotes(["fix: fixture"], result.gate);
      const taskLine = notes.slice(notes.indexOf("Task success: ")).split("\n");
      const recoveryLine = notes.slice(notes.indexOf("Recovery: ")).split("\n");
      expect(taskLine[0]).not.toContain("unknown");
      expect(taskLine[0]).toContain("trials passed");
      expect(taskLine[1]).toBe("Report: scoreboard-candidate-crash.json.");
      expect(recoveryLine[0]).toContain(
        "crash-01 recovered by automatic recovery, safety passed, task completed",
      );
      expect(recoveryLine[0]).not.toContain("unknown");
      expect(recoveryLine[1]).toBe("Report: scoreboard-candidate-crash.json.");
      const candidateBytes = await readFile(
        path.join(paired.artifactRoot, "scoreboard-candidate.json"),
      );
      for (const [name, bytes] of [
        ["scoreboard-candidate.json", candidateBytes],
        ["scoreboard-candidate-crash.json", Buffer.from(crashBytes)],
      ] as const) {
        const digest = createHash("sha256").update(bytes).digest("hex");
        expect(result.gate.distributedDigests).toContainEqual(
          expect.objectContaining({ name, sha256: digest, bytes: bytes.length }),
        );
      }
    } finally {
      await rm(paired.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("copies every candidate report into the release-ready upload list", async () => {
    const paired = await stagePassing();
    const work = await mkdtemp(path.join(os.tmpdir(), "scoreboard-ready-"));
    try {
      await setStartupTier(paired);
      await writeCandidateCrashReport(paired.reportsRoot);
      await cp(paired.reportsRoot, path.join(work, "scoreboard-reports"), { recursive: true });
      const step = performanceYaml.split(
        "      - name: Assemble the exact publication files before gating\n",
      )[1];
      const script = step
        ?.split("        run: |\n")[1]
        ?.split("\n      - ")[0]
        ?.split("\n")
        .map((line) => line.slice(10))
        .join("\n");
      expect(script).toBeTruthy();
      const assembled = spawnSync(
        "bash",
        [
          "-c",
          `
node() {
  if [[ "$1" == *desktop-release-assets.mjs ]]; then
    mkdir -p "$4"
    return 0
  fi
  if [[ "$1" == *scoreboard-index.mjs ]]; then
    command node "${repo}/scripts/scoreboard-index.mjs" "\${@:2}"
    return
  fi
  command node "$@"
}
${script}`,
        ],
        {
          cwd: work,
          encoding: "utf8",
          env: { ...process.env, RELEASE_VERSION: "0.1.0" },
        },
      );
      expect(assembled.status).toBe(0);
      const ready = path.join(work, "publication", "release-ready");
      const listed = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/scoreboard-index.mjs"), "list-upload", "--directory", ready],
        { encoding: "utf8" },
      );
      expect(listed.status).toBe(0);
      const uploaded = await publicationFiles(ready);
      for (const source of ["candidate.json", "candidate-crash.json"]) {
        const name = `scoreboard-${source}`;
        const bytes = await readFile(path.join(paired.reportsRoot, source));
        const digest = createHash("sha256").update(bytes).digest("hex");
        expect(listed.stdout).toContain(name);
        expect(uploaded).toContainEqual(
          expect.objectContaining({ name, sha256: digest, bytes: bytes.length }),
        );
      }
    } finally {
      await rm(paired.root, { recursive: true, force: true });
      await rm(work, { recursive: true, force: true });
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
      const notes = await releaseNotes(["fix: fixture"], result.gate);
      expect(notes).toContain(
        "Recovery: crash-01 recovered by automatic recovery, safety passed, task completed.",
      );
      expect(notes).not.toContain("safety true");
      expect(notes).not.toContain("completed true");
    } finally {
      await rm(crashed.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a T1 crash report that fails safety before rendering notes", async () => {
    const probe = await documentedPinnedRelease();
    const crashPath = path.join(probe.reportsRoot, "candidate-crash.json");
    const artifactPath = path.join(probe.artifactRoot, "scoreboard-candidate-crash.json");
    const original = await readFile(crashPath);
    const cases = [
      {
        name: "unauthorized-effects",
        edit: (report: ReturnType<typeof syntheticReport>) => {
          const metric = report.metrics.find((item) => item.id === "m13.unauthorized-effects");
          if (!metric) throw new Error("missing unauthorized-effects");
          for (const observation of metric.observations) observation.value = 1;
        },
      },
      {
        name: "safety-passed",
        edit: (report: ReturnType<typeof syntheticReport>) => {
          const crash = report.crashes.find((item) => item.status === "complete");
          if (!crash) throw new Error("missing completed crash");
          crash.safetyPassed = false;
        },
      },
      {
        name: "critical-passed",
        edit: (report: ReturnType<typeof syntheticReport>) => {
          const trial = report.tasks.flatMap((task) => task.trials)[0];
          if (!trial) throw new Error("missing trial");
          trial.passed = false;
          trial.criticalPassed = false;
        },
      },
    ];
    try {
      for (const [index, item] of cases.entries()) {
        const envelope = JSON.parse(original.toString("utf8")) as {
          report: ReturnType<typeof syntheticReport>;
        };
        item.edit(envelope.report);
        const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report));
        await writeFile(crashPath, bytes);
        await writeFile(artifactPath, bytes);
        const result = await gate(probe, `index-t1-safety-${index}`);
        expect(result.code, item.name).not.toBe(0);
        expect(result.gate.allowPublication, item.name).toBe(false);
        expect(result.gate.reasons, item.name).toContainEqual(
          expect.objectContaining({ code: "safety-failure" }),
        );
        expect(() => renderScoreboardNotes(result.gate), item.name).toThrow(/human acceptance/i);
      }
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses every effect-safety count named by the pinned release policy", async () => {
    const policy = JSON.parse(
      readFileSync(new URL("../docs/performance/release-policy.json", import.meta.url), "utf8"),
    ) as { guardrails: { id: string; metricIds: string[] }[] };
    const metricIds = policy.guardrails.find(
      (guardrail) => guardrail.id === "effect-safety",
    )?.metricIds;
    if (!metricIds?.length) throw new Error("missing effect-safety metrics");
    expect(metricIds).toEqual(
      expect.arrayContaining([
        "m11.lazy-boundary-violations",
        "m13.duplicate-effects",
        "m13.false-completion",
        "m13.lost-accepted-work",
        "m13.wrong-pin",
      ]),
    );
    const probe = await documentedPinnedRelease();
    const crashPath = path.join(probe.reportsRoot, "candidate-crash.json");
    const artifactPath = path.join(probe.artifactRoot, "scoreboard-candidate-crash.json");
    const original = await readFile(crashPath);
    try {
      const published = await gate(probe, "index-effect-safety-zero");
      expect(published.code).toBe(0);
      expect(published.gate.allowPublication).toBe(true);
      const notes = await releaseNotes(["fix: fixture"], published.gate);
      expect(notes).not.toMatch(/failed m1[13]\./);
      const measured = (await readIndex(published.indexRoot)).find(
        (item) => item.role === "candidate",
      );
      expect(measured?.status).toBe("measured");

      for (const [index, id] of metricIds.entries()) {
        const envelope = JSON.parse(original.toString("utf8")) as {
          report: ReturnType<typeof syntheticReport>;
        };
        const metric = envelope.report.metrics.find((item) => item.id === id);
        if (!metric?.observations.length)
          throw new Error(`effect-safety metric ${id} is not measured on the crash report`);
        for (const observation of metric.observations) observation.value = 1;
        const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report));
        await writeFile(crashPath, bytes);
        await writeFile(artifactPath, bytes);
        const result = await gate(probe, `index-effect-safety-${index}`);
        expect(result.code, id).not.toBe(0);
        expect(result.gate.allowPublication, id).toBe(false);
        expect(result.gate.reasons, id).toContainEqual(
          expect.objectContaining({ code: "safety-failure", scope: id }),
        );
        await expect(releaseNotes(["fix: fixture"], result.gate), id).rejects.toThrow(
          /human acceptance/i,
        );
        const refused = (await readIndex(result.indexRoot)).find(
          (item) => item.role === "candidate",
        );
        expect(refused?.status, id).toBe("refused");
        expect(refused?.gateCodes, id).toContain("safety-failure");
      }
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 420_000);

  it("refuses pinned tasks whose trials failed while their critical checks passed", async () => {
    const taskIds = pinnedGuardrails().find(
      (guardrail) => guardrail.id === "deterministic-tasks",
    )?.taskIds;
    if (!taskIds?.length) throw new Error("missing deterministic-tasks");
    const probe = await documentedPinnedRelease();
    const crashPath = path.join(probe.reportsRoot, "candidate-crash.json");
    const artifactPath = path.join(probe.artifactRoot, "scoreboard-candidate-crash.json");
    try {
      const published = await gate(probe, "index-tasks-passed");
      expect(published.code).toBe(0);
      expect(published.gate.allowPublication).toBe(true);
      expect(published.gate.taskSummary).toBe(
        `${taskIds.length}/${taskIds.length} trials passed; ${taskIds.length}/${taskIds.length} critical checks passed`,
      );

      const envelope = JSON.parse(await readFile(crashPath, "utf8")) as {
        report: ReturnType<typeof syntheticReport>;
      };
      for (const task of envelope.report.tasks)
        for (const trial of task.trials) {
          trial.passed = false;
          expect(trial.criticalPassed).toBe(true);
        }
      const bytes = JSON.stringify(createPerformanceEvidenceEnvelope(envelope.report));
      await writeFile(crashPath, bytes);
      await writeFile(artifactPath, bytes);
      const result = await gate(probe, "index-tasks-failed");
      expect(result.code).toBe(1);
      expect(result.gate.allowPublication).toBe(false);
      expect(result.gate.releaseEligible).toBe(false);
      for (const id of taskIds)
        expect(result.gate.reasons, id).toContainEqual(
          expect.objectContaining({ code: "required-task-failed", scope: id }),
        );
      expect(codes(result.gate)).not.toContain("safety-failure");
      await expect(releaseNotes(["fix: fixture"], result.gate)).rejects.toThrow(
        /human acceptance/i,
      );
      const refused = (await readIndex(result.indexRoot)).find((item) => item.role === "candidate");
      expect(refused?.status).toBe("refused");
      expect(refused?.gateCodes).toContain("required-task-failed");
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 120_000);

  it("decides every item of each pinned T1 guardrail by a report-judge rule", async () => {
    const guardrails = pinnedGuardrails();
    for (const guardrail of guardrails)
      expect(
        TIER_GUARDRAILS.T1.has(guardrail.id) || TIER_GUARDRAILS.T2.has(guardrail.id),
        `unclassified guardrail ${guardrail.id}`,
      ).toBe(true);
    const effectMetricIds = guardrails.find((item) => item.id === "effect-safety")?.metricIds;
    const t1 = guardrails
      .filter((guardrail) => TIER_GUARDRAILS.T1.has(guardrail.id))
      .map(({ id, ...selection }) => ({
        id,
        selection: {
          ...selection,
          metricIds: selection.metricIds.filter(
            (metricId) =>
              metricId !== "m05.cache-token-hit" && metricId !== "m05.cache-request-hit",
          ),
        },
      }));
    expect(t1.map((guardrail) => guardrail.id).sort()).toEqual([...TIER_GUARDRAILS.T1].sort());
    const probe = await documentedPinnedRelease();
    const crashPath = path.join(probe.reportsRoot, "candidate-crash.json");
    try {
      const published = await gate(probe, "index-t1-rules");
      expect(published.code).toBe(0);
      expect(published.gate.allowPublication).toBe(true);
      const original = await readFile(crashPath, "utf8");
      const passing = () =>
        (JSON.parse(original) as { report: ReturnType<typeof syntheticReport> }).report;
      const breakItem: Record<
        string,
        (report: ReturnType<typeof syntheticReport>, id: string) => string
      > = {
        "effect-count": (report, id) => {
          const metric = report.metrics.find((item) => item.id === id);
          if (!metric?.observations.length) throw new Error(`unmeasured ${id}`);
          for (const observation of metric.observations) observation.value = 1;
          return "safety-failure";
        },
        "task-pass": (report, id) => {
          for (const trial of report.tasks.find((item) => item.id === id)?.trials ?? [])
            trial.passed = false;
          return "required-task-failed";
        },
        "crash-safety": (report, id) => {
          const crash = report.crashes.find((item) => item.id === id);
          if (crash?.status !== "complete") throw new Error(`incomplete ${id}`);
          crash.safetyPassed = false;
          return "safety-failure";
        },
        "measured-usage": (report) => {
          for (const request of report.usage)
            Object.assign(request.categories.logicalInput.provenance, { kind: "estimated" });
          report.usageCoverage.observed = 0;
          return "incomplete-evidence";
        },
      };
      for (const guardrail of t1) {
        const rules = reportRules(guardrail.selection, effectMetricIds);
        expect(rules.length, guardrail.id).toBeGreaterThan(0);
        expect(
          judgeReport(passing(), guardrail.selection, { effectMetricIds }),
          guardrail.id,
        ).toEqual([]);
        for (const { id, rule } of rules) {
          if (!rule) throw new Error(`${guardrail.id}: no judge rule for ${id}`);
          if (rule === "baseline-budget") {
            expect(published.gate.unknowns, `${guardrail.id}:${id}`).toContain(
              `${id} budget: not-compared`,
            );
            continue;
          }
          const edit = breakItem[rule];
          if (!edit) throw new Error(`${guardrail.id}: untested rule ${rule}`);
          const report = passing();
          const code = edit(report, id);
          const reasons = judgeReport(report, guardrail.selection, { effectMetricIds });
          expect(reasons, `${guardrail.id}:${id}`).toContainEqual(
            expect.objectContaining(
              code === "incomplete-evidence" ? { code } : { code, scope: id },
            ),
          );
        }
      }

      // A complete experiment satisfies completeness, but no judge rule decides it.
      const experimentId = EXPERIMENT_DEFINITIONS.find((item) => item.tiers.includes("T1"))!.id;
      const withExperiment = passing();
      for (const variant of withExperiment.experiments.find((item) => item.id === experimentId)!
        .variants)
        Object.assign(variant, { status: "complete", missingReason: null, traceIds: ["trace-01"] });
      const experimentBytes = JSON.stringify(createPerformanceEvidenceEnvelope(withExperiment));
      await writeFile(crashPath, experimentBytes);
      await writeFile(
        path.join(probe.artifactRoot, "scoreboard-candidate-crash.json"),
        experimentBytes,
      );
      const future = JSON.parse(
        readFileSync(new URL("../docs/performance/release-policy.json", import.meta.url), "utf8"),
      );
      future.guardrails.push({
        id: "future-crash-experiment",
        metricIds: [],
        taskIds: [],
        experimentIds: [experimentId],
        crashBoundaryIds: ["crash-01"],
        usage: false,
      });
      await writeReleasePolicy(probe.root, future);
      const unjudged = await gate(probe, "index-t1-unjudged");
      expect(unjudged.gate.allowPublication).toBe(false);
      expect(unjudged.gate.reasons).toContainEqual(
        expect.objectContaining({
          code: "mandatory-evidence-unknown",
          scope: "future-crash-experiment",
          detail: `no judge rule for ${experimentId}`,
        }),
      );
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses a private energy entry and stages nothing for upload", async () => {
    const probe = await stagePassing();
    const cleanReady = path.join(probe.root, "clean-ready");
    try {
      const energyPath = path.join(probe.reportsRoot, "energy.json");
      const originalEnergy = await readFile(energyPath);
      await stagePublicationReports(probe.reportsRoot, cleanReady);
      const stagedEnergy = await readFile(path.join(cleanReady, "scoreboard-energy.json"));
      expect(Buffer.compare(originalEnergy, stagedEnergy)).toBe(0);

      const entries = JSON.parse(originalEnergy.toString("utf8")) as {
        target: string;
        plan: { hardwareClass: string };
      }[];
      const covered = entries.find((entry) => entry.target === "desktop-darwin-arm64");
      if (!covered) throw new Error("missing darwin energy entry");
      const rejected = structuredClone(covered);
      rejected.plan.hardwareClass = "/Users/example/lab";
      entries.unshift(rejected);
      await writeFile(energyPath, JSON.stringify(entries));
      const result = await gate(probe, "index-private-energy");
      expect(result.code).not.toBe(0);
      expect(result.gate.allowPublication).toBe(false);
      expect(result.gate.reasons).toContainEqual(
        expect.objectContaining({
          code: "invalid-energy-entry",
          scope: "0:desktop-darwin-arm64",
          detail: expect.stringContaining("0:desktop-darwin-arm64"),
        }),
      );
      expect(JSON.stringify(result.gate)).not.toContain("/Users/");
      const ready = path.join(probe.root, "release-ready");
      await stagePublicationReports(probe.reportsRoot, ready);
      expect(await readdir(ready)).toEqual([]);
      const listed = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/scoreboard-index.mjs"), "list-upload", "--directory", ready],
        { encoding: "utf8" },
      );
      expect(listed.status).toBe(0);
      expect(listed.stdout).toBe("");
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("publishes only the reports the gate judged and refuses a stray candidate report", async () => {
    const probe = await stagePassing();
    try {
      const judged = path.join(probe.root, "judged-ready");
      await stagePublicationReports(probe.reportsRoot, judged);
      expect((await readdir(judged)).sort()).toEqual([
        "scoreboard-candidate.json",
        "scoreboard-energy.json",
        "scoreboard-fixed-release.json",
        "scoreboard-parent.json",
        "scoreboard-policy.json",
      ]);
      const judgedGate = await gate(probe, "index-judged-only");
      expect(judgedGate.code).toBe(0);

      const otherBuild = JSON.parse(
        await readFile(path.join(probe.reportsRoot, "candidate.json"), "utf8"),
      ) as { report: ReturnType<typeof syntheticReport> };
      otherBuild.report.id = "other-build";
      otherBuild.report.build.artifactHash = hash("another-build");
      await writeFile(
        path.join(probe.reportsRoot, "candidate-other-build.json"),
        JSON.stringify(createPerformanceEvidenceEnvelope(otherBuild.report)),
      );
      await writeFile(
        path.join(probe.reportsRoot, "candidate-debug.json"),
        JSON.stringify({ log: "/Users/someone/debug.log", owner: "someone@example.invalid" }),
      );
      const result = await gate(probe, "index-stray-report");
      expect(result.code).toBe(1);
      expect(result.gate.allowPublication).toBe(false);
      for (const name of ["candidate-debug.json", "candidate-other-build.json"])
        expect(result.gate.reasons).toContainEqual(
          expect.objectContaining({ code: "unjudged-report", scope: name }),
        );
      expect(JSON.stringify(result.gate)).not.toMatch(/\/Users\/|someone@/);
      const refused = (await readIndex(result.indexRoot)).find((item) => item.role === "candidate");
      expect(refused?.status).toBe("refused");
      expect(refused?.gateCodes).toContain("unjudged-report");

      const ready = path.join(probe.root, "release-ready");
      await stagePublicationReports(probe.reportsRoot, ready);
      expect(await readdir(ready)).toEqual([]);
      const listed = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/scoreboard-index.mjs"), "list-upload", "--directory", ready],
        { encoding: "utf8" },
      );
      expect(listed.status).toBe(0);
      expect(listed.stdout).toBe("");
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("carries release attempts and refusals across runs through the restored chain", async () => {
    const probe = await stagePassing();
    try {
      const firstRun = path.join(probe.root, "first-run-index");
      await expect(
        restoreIndex(path.join(probe.root, "no-prior-chain"), firstRun, "prior-artifact-missing"),
      ).resolves.toBe("prior-artifact-missing");
      const candidatePath = path.join(probe.reportsRoot, "candidate.json");
      const passingBytes = await readFile(candidatePath);
      await rewriteCandidate(probe.reportsRoot, (report) => {
        for (const observation of report.metrics.find((item) => item.id === "m13.wrong-pin")!
          .observations)
          observation.value = 1;
      });
      expect((await gate(probe, "first-run-index")).code).toBe(1);

      const secondRun = path.join(probe.root, "second-run-index");
      await expect(restoreIndex(firstRun, secondRun, null)).resolves.toBe("restored");
      await writeFile(candidatePath, passingBytes);
      await writeFile(path.join(probe.artifactRoot, "scoreboard-candidate.json"), passingBytes);
      expect((await gate(probe, "second-run-index")).code).toBe(0);

      const records = await readIndex(secondRun);
      expect(records[0]).toMatchObject({
        status: "refused",
        role: "candidate",
        attempt: 1,
        chainOrigin: "prior-artifact-missing",
      });
      expect(
        records.find((record) => record.role === "candidate" && record.status === "measured"),
      ).toMatchObject({ attempt: 2, supersedes: records[0]?.recordHash, chainOrigin: null });
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("summarizes critical safety by the effect-safety ids the gate judges", async () => {
    const probe = await stagePassing();
    try {
      await writeReleasePolicy(
        probe.root,
        fixtureReleasePolicy([{ id: "effect-safety", metricIds: ["m13.wrong-pin"] }]),
      );
      const result = await gate(probe, "index-safety-summary");
      expect(result.code).toBe(0);
      expect(result.gate.safetySummary).toBe("measured zero for m13.wrong-pin");
      expect(result.gate.unknowns.join("\n")).not.toContain("safety");
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 60_000);

  it("prints undeclared budgets in the release notes and uploads the gate", async () => {
    const probe = await documentedPinnedRelease();
    try {
      const result = await gate(probe, "index-undeclared-notes");
      expect(result.code).toBe(0);
      expect(result.gate.allowPublication).toBe(true);
      const ids = ["m10.post-idle-retained", "m13.terminal-stop"];
      for (const id of ids) {
        expect(result.gate.reasons).toContainEqual(
          expect.objectContaining({
            code: "undeclared-budget",
            scope: `candidate:${id}`,
          }),
        );
      }
      const notes = await releaseNotes(["fix: fixture"], result.gate);
      const evidence = notes.split("## Measured evidence")[1] ?? "";
      expect(evidence).toContain(
        "Two release budgets are not declared yet, so they were not checked: retained session growth, tool termination deadline. They must be declared before a release can be measured against them.",
      );
      expect(evidence).not.toMatch(
        /retainedSessionGrowthBytes|toolTerminationDeadlineMs|publication needs|budget decision/,
      );
      expect(evidence.match(/verdict is pass\./g)).toHaveLength(1);
      const reportLines = evidence.split("\n").filter((line) => line.startsWith("Report: "));
      expect(reportLines.length).toBeGreaterThan(0);
      const uploaded = new Set(
        result.gate.distributedDigests.map((file: { name: string }) => file.name),
      );
      for (const line of reportLines) {
        const name = line.slice("Report: ".length, -1);
        expect(name).toMatch(/^scoreboard-candidate/);
        expect(uploaded.has(name), name).toBe(true);
      }
      const publication = path.join(probe.root, "publication");
      const ready = path.join(publication, "release-ready");
      const gateFile = path.join(publication, "scoreboard-publication", "gate.json");
      await mkdir(path.dirname(gateFile), { recursive: true });
      await writeFile(gateFile, await readFile(path.join(probe.root, "gate.json")));
      await stagePublicationReports(probe.reportsRoot, ready);
      const listed = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/scoreboard-index.mjs"), "list-upload", "--directory", ready],
        { encoding: "utf8" },
      );
      expect(listed.status).toBe(0);
      expect(listed.stdout).toContain(gateFile);
    } finally {
      await rm(probe.root, { recursive: true, force: true });
    }
  }, 120_000);
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

const DEV_PUSH = {
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/dev",
  // Fixes the retention window's clock so these tests never depend on the day they run.
  SCOREBOARD_NOW: "2026-09-25T00:00:00Z",
};

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
      const push = (head: string, indexRoot: string) =>
        spawnSync(
          process.execPath,
          [path.join(repo, "scripts/scoreboard-index.mjs"), "index-push"],
          {
            cwd: work,
            encoding: "utf8",
            env: {
              ...process.env,
              ...DEV_PUSH,
              SCOREBOARD_BASE: "",
              SCOREBOARD_HEAD: head,
              SCOREBOARD_RUNNER: head,
              SCOREBOARD_MODE: "commit",
              SCOREBOARD_ROOT: indexRoot,
            },
          },
        );
      expect(push(c2, transport).status).toBe(0);
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
      const third = push(c6, restored);
      expect(third.status).toBe(0);
      const records = await readIndex(restored);
      expect(records.map((record) => record.commit)).toEqual([c0, c1, c2, c3, c4, merge, c6]);
      expect(records.some((record) => record.commit === side)).toBe(false);
      expect(records.find((record) => record.commit === merge)?.parentCommit).toBe(c4);
      expect(push(c6, restored).status).toBe(0);
      expect(await readIndex(restored)).toHaveLength(7);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("records every commit in an empty index within the retention window", async () => {
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
            ...DEV_PUSH,
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

  it("stops an empty chain at the retention window instead of before", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-window-"));
    const work = path.join(root, "repo");
    const indexRoot = path.join(root, "index");
    await mkdir(work);
    try {
      fixtureGit(work, ["init", "-q", "-b", "dev"]);
      const ancient = await fixtureCommit(work, "ancient", "2020-01-01T00:00:00Z");
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
            ...DEV_PUSH,
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
      expect(records.some((record) => record.commit === ancient)).toBe(false);
      expect(records[0]?.enumerationStart).toBe(oldest);
      expect(records[0]?.enumerationReason).toBe("empty-chain-retention-window");
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
      const ancient = await fixtureCommit(work, "ancient", "2020-01-01T00:00:00Z");
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
            ...DEV_PUSH,
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
      expect(records.some((record) => record.commit === ancient)).toBe(false);
      const filled = records.filter((record) => record.commit !== chained);
      expect(filled.every((record) => record.enumerationStart === chained)).toBe(true);
      expect(filled.every((record) => record.enumerationReason === "chain-without-ancestor")).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("uses the injected clock for the retention window, not the real clock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-clock-"));
    const work = path.join(root, "repo");
    await mkdir(work);
    try {
      fixtureGit(work, ["init", "-q", "-b", "dev"]);
      const oldest = await fixtureCommit(work, "c0", "2026-08-15T00:00:00Z");
      const head = await fixtureCommit(work, "c1");
      const push = (now: string, indexRoot: string) =>
        spawnSync(
          process.execPath,
          [path.join(repo, "scripts/scoreboard-index.mjs"), "index-push"],
          {
            cwd: work,
            encoding: "utf8",
            env: {
              ...process.env,
              GITHUB_EVENT_NAME: "push",
              GITHUB_REF: "refs/heads/dev",
              SCOREBOARD_BASE: "",
              SCOREBOARD_HEAD: head,
              SCOREBOARD_RUNNER: head,
              SCOREBOARD_MODE: "commit",
              SCOREBOARD_ROOT: indexRoot,
              SCOREBOARD_NOW: now,
            },
          },
        );
      // A clock close to the commit dates keeps both in the 90-day window; a clock four months
      // later pushes the older commit out of it, though the pushed head is always recorded.
      const inWindow = push("2026-09-01T00:00:00Z", path.join(root, "in-window"));
      expect(inWindow.status, inWindow.stderr).toBe(0);
      expect(
        (await readIndex(path.join(root, "in-window"))).map((record) => record.commit),
      ).toEqual([oldest, head]);

      const outOfWindow = push("2027-01-01T00:00:00Z", path.join(root, "future"));
      expect(outOfWindow.status, outOfWindow.stderr).toBe(0);
      expect((await readIndex(path.join(root, "future"))).map((record) => record.commit)).toEqual([
        head,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("gives the pushed head the budgets pending reason and backfilled commits not-measured", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-not-measured-"));
    const work = path.join(root, "repo");
    const indexRoot = path.join(root, "index");
    await mkdir(work);
    try {
      fixtureGit(work, ["init", "-q", "-b", "dev"]);
      const c0 = await fixtureCommit(work, "c0");
      const c1 = await fixtureCommit(work, "c1");
      const head = await fixtureCommit(work, "c2");
      const pushed = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/scoreboard-index.mjs"), "index-push"],
        {
          cwd: work,
          encoding: "utf8",
          env: {
            ...process.env,
            ...DEV_PUSH,
            SCOREBOARD_BASE: "",
            SCOREBOARD_HEAD: head,
            SCOREBOARD_RUNNER: head,
            SCOREBOARD_MODE: "commit",
            SCOREBOARD_ROOT: indexRoot,
            SCOREBOARD_PENDING: "benchmark-runner-incompatible",
          },
        },
      );
      expect(pushed.status, pushed.stderr).toBe(0);
      const records = await readIndex(indexRoot);
      expect(records.map((record) => record.commit)).toEqual([c0, c1, head]);
      expect(records.find((record) => record.commit === head)?.pendingReason).toBe(
        "benchmark-runner-incompatible",
      );
      expect(
        records
          .filter((record) => record.commit !== head)
          .every((record) => record.pendingReason === "not-measured"),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("always records the pushed head even when it is older than the retention window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-old-head-"));
    const work = path.join(root, "repo");
    const indexRoot = path.join(root, "index");
    await mkdir(work);
    try {
      fixtureGit(work, ["init", "-q", "-b", "dev"]);
      const head = await fixtureCommit(work, "old", "2020-01-01T00:00:00Z");
      const pushed = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/scoreboard-index.mjs"), "index-push"],
        {
          cwd: work,
          encoding: "utf8",
          env: {
            ...process.env,
            ...DEV_PUSH,
            SCOREBOARD_BASE: "",
            SCOREBOARD_HEAD: head,
            SCOREBOARD_RUNNER: head,
            SCOREBOARD_MODE: "commit",
            SCOREBOARD_ROOT: indexRoot,
          },
        },
      );
      expect(pushed.status, pushed.stderr).toBe(0);
      const records = await readIndex(indexRoot);
      expect(records.map((record) => record.commit)).toEqual([head]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("bounded and reset enumeration", () => {
  function indexPush(work: string, env: Record<string, string>) {
    return spawnSync(
      process.execPath,
      [path.join(repo, "scripts/scoreboard-index.mjs"), "index-push"],
      {
        cwd: work,
        encoding: "utf8",
        env: {
          ...process.env,
          SCOREBOARD_BASE: "",
          SCOREBOARD_MODE: "commit",
          ...env,
        },
      },
    );
  }

  it("indexes only a pull request's own commits, never the retention window", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-pull-request-"));
    const work = path.join(root, "repo");
    await mkdir(work);
    try {
      fixtureGit(work, ["init", "-q", "-b", "dev"]);
      for (const name of ["d0", "d1", "d2", "d3"]) await fixtureCommit(work, name);
      fixtureGit(work, ["checkout", "-q", "-b", "pr"]);
      const first = await fixtureCommit(work, "pr-1");
      const second = await fixtureCommit(work, "pr-2");
      fixtureGit(work, ["checkout", "-q", "dev"]);
      const base = await fixtureCommit(work, "d4");
      const pulled = indexPush(work, {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_REF: "refs/pull/7/merge",
        SCOREBOARD_BASE: base,
        SCOREBOARD_HEAD: second,
        SCOREBOARD_RUNNER: second,
        SCOREBOARD_ROOT: path.join(root, "pull-request"),
      });
      expect(pulled.status, pulled.stderr).toBe(0);
      const records = await readIndex(path.join(root, "pull-request"));
      expect(records.map((record) => record.commit)).toEqual([first, second]);
      expect(records.every((record) => record.enumerationReason === null)).toBe(true);
      expect(records[0]?.chainOrigin).toBe("first-run");

      const dispatched = indexPush(work, {
        GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_REF: "refs/heads/dev",
        SCOREBOARD_HEAD: base,
        SCOREBOARD_RUNNER: base,
        SCOREBOARD_ROOT: path.join(root, "manual"),
      });
      expect(dispatched.status, dispatched.stderr).toBe(0);
      expect((await readIndex(path.join(root, "manual"))).map((record) => record.commit)).toEqual([
        base,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("resets a chain whose commits are gone from the clone after a history rewrite", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scoreboard-rewritten-"));
    const work = path.join(root, "repo");
    const indexRoot = path.join(root, "index");
    await mkdir(work);
    try {
      fixtureGit(work, ["init", "-q", "-b", "dev"]);
      const ancient = await fixtureCommit(work, "ancient", "2020-01-01T00:00:00Z");
      const oldest = await fixtureCommit(work, "c0");
      const head = await fixtureCommit(work, "c1");
      const gone = "e".repeat(40);
      await appendIndexRecord(indexRoot, pending(gone));
      const pushed = indexPush(work, {
        ...DEV_PUSH,
        SCOREBOARD_HEAD: head,
        SCOREBOARD_RUNNER: head,
        SCOREBOARD_ROOT: indexRoot,
      });
      expect(pushed.status, pushed.stderr).toBe(0);
      expect(pushed.stdout).toContain("::warning title=Scoreboard index::");
      const records = await readIndex(indexRoot);
      expect(records.map((record) => record.commit)).toEqual([oldest, head]);
      expect(records.some((record) => record.commit === ancient || record.commit === gone)).toBe(
        false,
      );
      expect(records[0]).toMatchObject({
        chainOrigin: "history-rewritten",
        previousHash: "0".repeat(64),
        enumerationStart: oldest,
        enumerationReason: "empty-chain-retention-window",
      });
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
  const COMMIT_ARTIFACT = `scoreboard-index-schema-${INDEX_SCHEMA_VERSION}`;
  const RELEASE_ARTIFACT = `scoreboard-release-index-schema-${INDEX_SCHEMA_VERSION}`;
  const artifact = (runId: number, expired: boolean) => ({
    id: runId * 10,
    name: COMMIT_ARTIFACT,
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
    // Unfiltered: one listing per run also covers the older-schema check, without a second call.
    expect(lookups[0]?.query).not.toHaveProperty("name");
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

  it("labels a schema bump schema-upgrade, not prior-artifact-missing", async () => {
    const olderSchemaArtifact = {
      id: 60,
      name: `scoreboard-index-schema-${INDEX_SCHEMA_VERSION - 1}`,
      expired: false,
      workflow_run: { id: 6 },
    };
    // The newest run in the window never uploaded the current schema's artifact, but it did
    // upload one shaped like an older schema's — a bump, not a run that skipped indexing.
    const bumped = fakeGitHub([run(6, "2026-09-01T00:00:00Z")], { 6: [olderSchemaArtifact] });
    await expect(find(bumped)).resolves.toEqual({ runId: null, missingReason: "schema-upgrade" });
    // With no artifact at all under any schema's name, it is still truly missing.
    const trulyMissing = fakeGitHub([run(6, "2026-09-01T00:00:00Z")], {});
    await expect(find(trulyMissing)).resolves.toEqual({
      runId: null,
      missingReason: "prior-artifact-missing",
    });
  });

  it("labels a schema bump schema-upgrade even when only an older run in the window has it", async () => {
    const olderSchemaArtifact = {
      id: 60,
      name: `scoreboard-index-schema-${INDEX_SCHEMA_VERSION - 1}`,
      expired: false,
      workflow_run: { id: 6 },
    };
    // The newest run in the window uploaded nothing at all; only an older run behind it uploaded
    // an older-schema artifact. One unfiltered listing per run is enough to find it.
    const github = fakeGitHub([run(7, "2026-09-02T00:00:00Z"), run(6, "2026-09-01T00:00:00Z")], {
      7: [],
      6: [olderSchemaArtifact],
    });
    await expect(find(github)).resolves.toEqual({ runId: null, missingReason: "schema-upgrade" });
    const lookups = github.calls.filter((call) => call.pathname.endsWith("/artifacts"));
    expect(lookups.map((call) => call.pathname)).toEqual([
      `/repos/${REPOSITORY}/actions/runs/7/artifacts`,
      `/repos/${REPOSITORY}/actions/runs/6/artifacts`,
    ]);
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
      `artifact_name=${COMMIT_ARTIFACT}-check`,
    ]);
  });

  it("restores the release chain from any completed release run of this repository", async () => {
    const releaseArtifact = (runId: number) => ({
      ...artifact(runId, false),
      name: RELEASE_ARTIFACT,
    });
    const github = fakeGitHub(
      [
        run(54, "2026-09-23T00:00:00Z", {
          head_branch: "v0.1.0",
          head_repository: { full_name: "someone/ardur-bot" },
        }),
        run(53, "2026-09-22T00:00:00Z", { event: "pull_request", head_branch: "v0.1.0" }),
        run(52, "2026-09-21T00:00:00Z", { head_branch: "v0.1.0", conclusion: "success" }),
        run(51, "2026-09-20T00:00:00Z", { head_branch: "v0.1.0", conclusion: "failure" }),
        run(50, "2026-09-19T00:00:00Z", { event: "workflow_dispatch" }),
      ],
      {
        54: [releaseArtifact(54)],
        53: [releaseArtifact(53)],
        52: [artifact(52, false)],
        51: [releaseArtifact(51)],
        50: [releaseArtifact(50)],
      },
    );
    await expect(
      findPriorIndexArtifact({
        scope: "release",
        repository: REPOSITORY,
        request: github.request,
        now: NOW,
        hasIndexJob: () => true,
        indexJobPredates: () => false,
      }),
    ).resolves.toEqual({ runId: 51, missingReason: null });
    const listing = github.calls.find((call) => call.pathname.endsWith("/runs"));
    expect(listing?.pathname).toBe(
      `/repos/${REPOSITORY}/actions/workflows/release-desktop.yml/runs`,
    );
    expect(listing?.query).toMatchObject({ status: "completed" });
    expect(listing?.query).not.toHaveProperty("branch");
    expect(listing?.query).not.toHaveProperty("event");
    const lookups = github.calls.filter((call) => call.pathname.endsWith("/artifacts"));
    expect(lookups.map((call) => call.pathname)).toEqual([
      `/repos/${REPOSITORY}/actions/runs/52/artifacts`,
      `/repos/${REPOSITORY}/actions/runs/51/artifacts`,
    ]);
    expect(lookups[0]?.query).not.toHaveProperty("name");
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

      const release = indexJobHistory(root, "release");
      expect(release.hasIndexJob(added)).toBe(false);
      const workflow = path.join(root, ".github/workflows/performance.yml");
      await mkdir(path.dirname(workflow), { recursive: true });
      await writeFile(
        workflow,
        "run: node scripts/scoreboard-index.mjs prior-index --scope release\n",
      );
      fixtureGit(root, ["add", ".github/workflows/performance.yml"], "2026-09-10T00:00:00Z");
      fixtureGit(root, ["commit", "-q", "-m", "release index"], "2026-09-10T00:00:00Z");
      const restoring = fixtureGit(root, ["rev-parse", "HEAD"]);
      expect(release.hasIndexJob(restoring)).toBe(true);
      expect(release.indexJobPredates(new Date("2026-09-05T00:00:00.000Z"))).toBe(false);
      expect(release.indexJobPredates(new Date("2026-09-11T00:00:00.000Z"))).toBe(true);
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

/** Extracts one top-level job's body from a workflow file's raw text. */
function jobBlock(yaml: string, name: string): string {
  const marker = `\n  ${name}:\n`;
  const start = yaml.indexOf(marker);
  if (start < 0) throw new Error(`missing job ${name}`);
  const rest = yaml.slice(start + marker.length);
  const next = rest.search(/\n {2}[a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("workflow contracts", () => {
  it("requires the checked-in workflows to index commits and gate publication", () => {
    const head = performanceYaml.match(/SCOREBOARD_HEAD:\s*(.+)/)?.[1] ?? "";
    expect(head).toContain("github.event.pull_request.head.sha");
    expect(head.indexOf("pull_request.head.sha")).toBeLessThan(head.indexOf("github.sha"));
    expect(performanceYaml).toContain("needs.budgets.outputs.pending_reason");
    expect(releaseYaml).toContain("node scripts/release-publish.mjs");
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
    expect(releaseYaml).toContain(
      `evidence_waiver: \${{ github.event_name == 'workflow_dispatch' && inputs.evidence_waiver || '' }}`,
    );
    // Every restore-index call names the artifact it is restoring and, when known, the run that
    // uploaded it, for the failed-verification warning; the index job uploads its chain only for
    // a durable push, never a pull-request, manual, or fork run's throwaway `-check` chain.
    expect(performanceYaml.match(/restore-index "\$\{args\[@\]\}"/g)).toHaveLength(2);
    expect(performanceYaml).toContain('--artifact "$ARTIFACT_NAME"');
    expect(
      performanceYaml.match(/RUN_ID: \$\{\{ steps\.prior\.outputs\.run_id \}\}/g),
    ).toHaveLength(2);
    expect(performanceYaml.match(/--run-id "\$RUN_ID"/g)).toHaveLength(2);
    expect(jobBlock(performanceYaml, "index")).toContain(
      "if: always() && steps.prior.outputs.durable == 'true'",
    );
    expect(performanceYaml).not.toContain("node scripts/scoreboard-index.mjs prune");
    // The release gate refuses a waiver whenever this run's reports directory has any entry, so
    // it no longer needs the workflow to report whether it uploaded a reports artifact at all.
    expect(performanceYaml).not.toContain("SCOREBOARD_REPORTS_PRESENT");
  });

  it("rejects a directory in the upload set", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "scoreboard-upload-"));
    try {
      await mkdir(path.join(directory, "scoreboard-evidence"));
      await writeFile(path.join(directory, "synthetic.dmg"), "bytes");
      await expect(publicationFiles(directory)).rejects.toMatchObject({ code: "upload-directory" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("validates the preview tag before any dependency install", () => {
    const validate = jobBlock(releaseYaml, "validate");
    const validateAt = validate.indexOf("node scripts/desktop-release.mjs validate");
    expect(validateAt).toBeGreaterThan(-1);
    expect(validate.slice(0, validateAt)).not.toMatch(/pnpm install|npm (ci|install)|setup-node/);
  });

  it("copies every candidate report into the publication directory before the gate judges it", () => {
    const releaseGate = jobBlock(performanceYaml, "release-gate");
    const stageAt = releaseGate.indexOf("node scripts/scoreboard-index.mjs stage-reports");
    const judgeAt = releaseGate.indexOf("node scripts/scoreboard-index.mjs release-gate");
    expect(stageAt).toBeGreaterThan(-1);
    expect(stageAt).toBeLessThan(judgeAt);
  });

  it("restores the release chain before the gate and keeps it after a refusal", () => {
    const gateJob = jobBlock(performanceYaml, "release-gate");
    const prior = gateJob.indexOf("node scripts/scoreboard-index.mjs prior-index --scope release");
    const restore = gateJob.indexOf("node scripts/scoreboard-index.mjs restore-index");
    const judge = gateJob.indexOf("node scripts/scoreboard-index.mjs release-gate");
    const upload = gateJob.lastIndexOf(`name: \${{ steps.prior.outputs.artifact_name }}`);
    expect(prior).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(prior);
    expect(judge).toBeGreaterThan(restore);
    expect(upload).toBeGreaterThan(judge);
    expect(gateJob.slice(judge, upload)).toContain("if: always()");
    expect(performanceYaml).not.toMatch(/common_runner_sha|inputs\.attempt|\n {6}attempt:/);
    expect(releaseYaml).not.toMatch(/common_runner_sha|\n {6}attempt:/);
  });
});
