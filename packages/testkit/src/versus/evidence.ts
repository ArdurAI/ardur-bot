import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MissingReason,
  PerformanceEvidenceReport,
  RequestUsageEvidence,
} from "../performance-report.js";
import { parsePerformanceEvidenceReport, USAGE_CATEGORIES } from "../performance-report.js";
import {
  CRASH_BOUNDARIES,
  canonicalSerialize,
  contentDigest,
  EXPERIMENT_DEFINITIONS,
  METRIC_DEFINITIONS,
  SCOREBOARD_MANIFEST,
} from "../scoreboard/manifest.js";
import type { TaskTrialEvidence } from "../scoreboard/replay/evidence.js";
import { replayTaskEvidence } from "../scoreboard/replay/evidence.js";
import { DEPARTMENT_TASKS, TASK_PACK_HASH } from "../scoreboard/tasks/catalog.js";
import type { VersusEvent } from "./adapters/types.js";
import type { Budget } from "./budget.js";
import { budgetTemplate, requireValue } from "./budget.js";
import type { GatewayRequest } from "./gateway.js";
import type { Product } from "./manifest.js";
import { frozenInputs, PARITY_TASKS, PRODUCTS, VERSUS_PROTOCOL } from "./manifest.js";
import type { HermesIdentity, inspectBuild } from "./provenance.js";
import { bytesHash, sanitize } from "./provenance.js";
import type { PairedResult, PairPlan } from "./scheduler.js";
import { analyzePairs } from "./scheduler.js";

export interface EvidenceTrial extends TaskTrialEvidence {
  product: Product;
  events: VersusEvent[];
  raw: unknown;
}
type Build = Awaited<ReturnType<typeof inspectBuild>>;
export interface EvidenceInput {
  mode: "dry-run" | "self-test" | "live";
  build: Build;
  hermes: HermesIdentity;
  plan: PairPlan[];
  budget: Budget | null;
  trials: EvidenceTrial[];
  results: PairedResult[];
  prerequisites: string[];
  launchPlan: unknown;
  protocolResults?: unknown;
  isolation?: unknown;
  budgetEvidence?: unknown;
}
export async function writeEvidence(output: string, input: EvidenceInput) {
  // Evidence is append-only by invocation. Reusing an output directory must never
  // mix a previous successful result with a later failure.
  await mkdir(output, { recursive: true, mode: 0o700 });
  requireValue((await readdir(output)).length === 0, "Evidence output must be empty");
  const artifactDirectory = path.join(output, "raw");
  await mkdir(artifactDirectory, { mode: 0o700 });
  const artifacts = new Map<string, PerformanceEvidenceReport["artifacts"][number]>();
  const raw = async (
    value: unknown,
    kind: PerformanceEvidenceReport["artifacts"][number]["kind"],
  ) => {
    const bytes = canonicalSerialize(value);
    const sha256 = bytesHash(bytes);
    if (!artifacts.has(sha256)) {
      await writeFile(path.join(artifactDirectory, `${sha256}.json`), bytes, {
        flag: "wx",
        mode: 0o600,
      });
      artifacts.set(sha256, { sha256, bytes: Buffer.byteLength(bytes), kind });
    }
    return sha256;
  };
  const readable = async (name: string, value: unknown) =>
    writeFile(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  requireValue(
    (await raw(input.build.buildArtifact, "build")) === input.build.build.artifactHash,
    "Forged build artifact hash",
  );
  for (const history of new Set(input.plan.map((pair) => pair.history)))
    await raw(frozenInputs(history), "fixture");
  await raw(
    {
      sourceHash: input.build.graderHash,
      owner: "W0-5",
      packHash: TASK_PACK_HASH,
      implementations: "scoreboard/graders/outcome.ts",
    },
    "grader",
  );
  const provenance = {
    harness: input.build.build,
    buildScope: "executed-harness-source-inventory",
    hermes: input.hermes,
    productExecutions:
      input.mode === "live" ? "see-retained-trials" : "none-or-scripted-application-protocols",
    sourceReference: {
      hermes: "https://github.com/NousResearch/hermes-agent",
      prime: "https://github.com/PrimeIntellect-ai/prime-agent",
      primeRevision: "e260085dd8f742e0def3d871860c9a888b114851",
      primeVersion: "0.9.6",
    },
  };
  await readable("source-provenance.json", provenance);
  const histories = [...new Set(input.plan.map((pair) => pair.history))];
  const reportFiles = PRODUCTS.flatMap((product) =>
    histories.map((history) => ({
      product,
      history,
      file: `${product}${histories.length > 1 ? `-${history}` : ""}-schema3.json`,
    })),
  );
  const manifest = {
    ...VERSUS_PROTOCOL,
    mode: input.mode,
    modelCalls: input.mode === "live" ? "see-gateway-ledger" : 0,
    modelQualification: input.mode === "live" ? "see-cohort-qualification" : "not-run",
    provenance,
    budgetHash: input.budget ? contentDigest(input.budget) : null,
    route: input.budget
      ? {
          endpoint: input.budget.endpoint,
          model: input.budget.model,
          contextSize: input.budget.contextSize,
          outputCap: input.budget.maxOutputTokens,
          temperature: input.budget.temperature,
          seed: input.budget.seed,
        }
      : null,
    plan: input.plan,
    reports: reportFiles,
    plannedTrialsAreObservations: false,
    fixtureCommitments: histories.flatMap((history) =>
      frozenInputs(history).map(({ material: _material, ...commitment }) => ({
        ...commitment,
        history,
      })),
    ),
    graderHash: input.build.graderHash,
    parity: PARITY_TASKS.map((task) => ({
      ...task,
      status: "unsupported",
      missingReason: "product-acceptance-not-measured",
      liveProductSuccess: null,
    })),
    protocolResults: input.protocolResults ?? null,
    currency: input.budget?.currency ?? null,
    humanMinutes: null,
    energyJoules: null,
    defaultPolicyDifferences: [
      "Hermes CLI output is not durable admission or UI paint.",
      "API-only Ardur does not measure packaged UI or onboarding.",
      "MCP names and native tool schemas differ; shared semantic authority does not imply identical prompts.",
    ],
    missingW0: [
      "W0-3 landed; versus request/purpose/cache/reasoning coverage not qualified",
      "W0-4 full cross-process and paint trace collection incomplete",
      "W0-6 fault/load qualification unmeasured",
      "W0-7 packaged resources unmeasured",
      "W0-9 release indexing outside this stream",
    ],
    analysis: analyzePairs(input.plan, input.results),
    prerequisites: input.prerequisites,
    isolation: input.isolation ?? null,
    budgetEvidence: input.budgetEvidence ?? null,
    cleanup:
      "Only invocation-owned resources may be stopped; raw evidence is retained after failure.",
  };
  await readable("versus-manifest.json", manifest);
  await raw(manifest, "raw");
  await readable("launch-plan.json", input.launchPlan);
  await raw(input.launchPlan, "raw");
  await readable("budget-template.json", budgetTemplate());
  const traces = new Map<string, PerformanceEvidenceReport["traces"][number]>();
  for (const trial of input.trials) {
    requireValue(
      trial.events.every(
        (event) => event.clock === (input.mode === "live" ? "monotonic" : "virtual"),
      ),
      "T0 protocol observations cannot masquerade as live traces",
    );
    const traceHash = await raw(trial.events, "trace");
    traces.set(trial.traceId, {
      id: trial.traceId,
      artifactHash: traceHash,
      clock: input.mode === "live" ? "monotonic" : "virtual",
    });
    await raw(trial.raw, "raw");
  }
  const reports: PerformanceEvidenceReport[] = [];
  for (const { product, history, file } of reportFiles) {
    const environment: PerformanceEvidenceReport["environment"] = {
      ...input.build.environment,
      containerDigests: [],
      buildMode: "source-harness",
      powerMode: "not-measured",
      thermalState: "not-measured",
      backgroundLoad: "not-measured",
      memoryAccounting: "not-measured",
      resourceLimitsHash: contentDigest(input.budget?.resources ?? { status: "not-authorized" }),
      sampleIntervalMs: null,
    };
    const cohort = input.plan.filter((pair) => pair.history === history);
    const selected = input.trials.filter(
      (trial) => trial.product === product && cohort.some((pair) => pair.id === trial.pairId),
    );
    const report: PerformanceEvidenceReport = {
      schemaVersion: 3,
      id: `versus-${product}-${history}-${input.mode}`,
      createdAt: new Date().toISOString(),
      manifestHash: contentDigest(SCOREBOARD_MANIFEST),
      build: input.build.build,
      hashes: {
        benchmark: contentDigest(VERSUS_PROTOCOL),
        fixture: TASK_PACK_HASH,
        grader: input.build.graderHash,
        dependencyLock: input.build.dependencyLock,
      },
      environment,
      environmentHash: contentDigest(environment),
      scenario: {
        id: `versus-${product}-${history}-core24`,
        tier: input.mode === "live" ? "T3" : "T0",
        comparisonMode: "controlled-harness",
        timingMode: input.mode === "live" ? "live" : "virtual",
        cacheState: input.budget?.cohort.cacheState ?? "not-measured",
        loadScheduleHash: contentDigest(cohort),
        routeHash: contentDigest(manifest.route ?? { status: "not-authorized" }),
        deadlineMs: input.budget?.perTrial.wallMs ?? 30000,
      },
      artifacts: [...artifacts.values()],
      traces: selected.map((trial) => traces.get(trial.traceId)!),
      metrics: METRIC_DEFINITIONS.map((metric) => ({
        id: metric.id,
        unit: metric.unit,
        direction: metric.direction,
        applicability: "applicable",
        missingReason: "not-measured",
        coverage: { expected: Math.max(1, cohort.length), observed: 0 },
        observations: [],
      })),
      tasks: replayTaskEvidence(selected),
      experiments: EXPERIMENT_DEFINITIONS.map((experiment) => ({
        id: experiment.id,
        variants: experiment.variants.map((id) => ({
          id,
          status: "incomplete",
          missingReason: "not-measured",
          traceIds: [],
        })),
      })),
      crashes: CRASH_BOUNDARIES.map((boundary) => ({
        id: boundary.id,
        status: "incomplete",
        missingReason: "not-measured",
        recovery: null,
        safetyPassed: null,
        taskCompleted: null,
        traceIds: [],
      })),
      usageCoverage: { expected: 0, observed: 0 },
      usage: [],
    };
    for (const trial of selected)
      for (const event of trial.events) {
        if (event.kind !== "usage" || event.source !== "provider-gateway") continue;
        const request = event.data as unknown as GatewayRequest;
        // Schema 3 has no unknown-purpose category. Preserve the raw request and
        // explicitly count the conversion gap; never fabricate a main-call label.
        if (request.purpose === null) continue;
        const sourceHash = traces.get(trial.traceId)!.artifactHash;
        const categories = Object.fromEntries(
          USAGE_CATEGORIES.map((key) => {
            const value = request.authoritative ? request.usage[key] : null;
            return [
              key,
              {
                value,
                missingReason:
                  value === null
                    ? ((request.missingReason ?? "provider-omitted") as MissingReason)
                    : null,
                provenance:
                  value === null
                    ? null
                    : { kind: input.mode === "live" ? "provider-live" : "virtual", sourceHash },
              },
            ];
          }),
        ) as RequestUsageEvidence["categories"];
        report.usage.push({
          requestId: request.id,
          turnId: trial.trialId,
          attemptId: request.id,
          parentRequestId: null,
          purpose: request.purpose,
          routeId: "shared-local-model",
          traceId: trial.traceId,
          outcome: request.outcome,
          inputSemantics: "total-with-cache-subsets",
          reasoningSemantics: "subset-of-output",
          requestHash: request.requestHash,
          usageRequestHash: request.requestHash,
          counter: { mode: "request-delta", epochId: request.id, sequence: 0 },
          categories,
        });
      }
    report.usageCoverage = {
      expected: report.usage.length,
      observed: report.usage.filter((request) =>
        Object.values(request.categories).every(
          (category) => category.value !== null && category.provenance?.kind === "provider-live",
        ),
      ).length,
    };
    const parsed = parsePerformanceEvidenceReport(report, `versus-${product}`);
    reports.push(parsed);
    await readable(file, parsed);
  }
  await writeFile(
    path.join(output, "trials.jsonl"),
    input.trials
      .map(({ events: _events, raw: _raw, ...trial }) => JSON.stringify(trial))
      .join("\n") + (input.trials.length ? "\n" : ""),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    path.join(output, "events.jsonl"),
    input.trials.flatMap((trial) => trial.events.map((event) => JSON.stringify(event))).join("\n") +
      (input.trials.length ? "\n" : ""),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    path.join(output, "effects.jsonl"),
    input.trials
      .flatMap((trial) =>
        trial.events
          .filter((event) => event.kind === "effect-receipt")
          .map((event) => JSON.stringify(event)),
      )
      .join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(
    path.join(output, "grades.jsonl"),
    input.trials
      .map((trial) =>
        JSON.stringify({
          blindId: `blind-${contentDigest(trial.trialId).slice(0, 24)}`,
          taskId: trial.taskId,
          grade: trial.grade,
        }),
      )
      .join("\n"),
    { flag: "wx", mode: 0o600 },
  );
  await readable("coverage.json", {
    requiredTasks: DEPARTMENT_TASKS.length,
    requiredMetrics: METRIC_DEFINITIONS.length,
    requiredExperiments: EXPERIMENT_DEFINITIONS.length,
    requiredCrashes: CRASH_BOUNDARIES.length,
    executedTrials: input.trials.length,
    measuredPerformanceMetrics: 0,
    exactUsageCoverage: "incomplete",
    unattributedRawRequests: input.trials
      .flatMap((trial) => trial.events)
      .filter(
        (event) =>
          event.kind === "usage" &&
          event.source === "provider-gateway" &&
          event.data.purpose === null,
      ).length,
    humanReview: "not-measured",
    liveQualification: input.mode === "live" ? "see-manifest" : "not-run",
  });
  const index = [
    `# Versus ${input.mode}`,
    "",
    `Model calls: ${input.mode === "live" ? "see gateway ledger" : "0"}. Live qualification: ${input.mode === "live" ? "see cohort evidence" : "not run"}.`,
    "",
    "Both schema-3 reports preserve the frozen W0 registry. Unmeasured fields remain incomplete. T0 contracts establish protocol behavior, not product quality or performance.",
    "",
    `Retained trials: ${input.trials.length}. Planned pairs: ${input.plan.length}. Performance metrics measured: 0. Superiority verdict: inconclusive.`,
    "",
    reportFiles
      .map(({ product, history, file }) => `[${product} ${history} schema 3](${file})`)
      .join(" · "),
    "[Manifest](versus-manifest.json) · [Provenance](source-provenance.json) · [Launch plan](launch-plan.json) · [Coverage](coverage.json) · [Trial sidecar](trials.jsonl) · [Events](events.jsonl)",
    "",
    "## Unmet prerequisites",
    "",
    ...input.prerequisites.map((reason) => `- ${sanitize(reason)}`),
    "",
    "## Live authorization",
    "",
    "Approve the numeric loopback endpoint, exact model digest/quantization and finite budget file. Native confinement, protocol qualification, resource enforcement, and complete route pinning must pass before either product starts. No automatic budget expansion or model installation is permitted.",
    "",
  ].join("\n");
  await writeFile(path.join(output, "index.md"), index, { flag: "wx", mode: 0o600 });
  await validateEvidenceDirectory(output, input.build.build, input.build.graderHash);
  const checksums = [];
  for (const name of (await readdir(output)).filter((name) => name !== "raw").sort())
    checksums.push({ name, sha256: bytesHash(await readFile(path.join(output, name))) });
  await readable("checksums.json", checksums);
  return reports;
}

export async function validateEvidenceDirectory(
  directory: string,
  build?: PerformanceEvidenceReport["build"],
  graderHash?: string,
) {
  const manifest = JSON.parse(
    await readFile(path.join(directory, "versus-manifest.json"), "utf8"),
  ) as {
    mode: string;
    plan: PairPlan[];
    graderHash: string;
    analysis: unknown;
    reports: { product: Product; history: "short" | "long"; file: string }[];
  };
  const histories = [...new Set(manifest.plan.map((pair) => pair.history))];
  const expectedFiles = PRODUCTS.flatMap((product) =>
    histories.map((history) => ({
      product,
      history,
      file: `${product}${histories.length > 1 ? `-${history}` : ""}-schema3.json`,
    })),
  );
  requireValue(
    contentDigest(manifest.reports) === contentDigest(expectedFiles),
    "Changed report cohort index",
  );
  for (const { product, history, file } of manifest.reports) {
    const report = parsePerformanceEvidenceReport(
      JSON.parse(await readFile(path.join(directory, file), "utf8")),
      product,
    );
    requireValue(
      !build || contentDigest(report.build) === contentDigest(build),
      "Forged build binding",
    );
    requireValue(
      report.hashes.grader === (graderHash ?? manifest.graderHash),
      "Changed grader binding",
    );
    requireValue(
      report.hashes.fixture === TASK_PACK_HASH &&
        report.hashes.benchmark === contentDigest(VERSUS_PROTOCOL),
      "Changed fixture or benchmark binding",
    );
    requireValue(
      (manifest.mode === "live") === (report.scenario.tier === "T3"),
      "T0 replay masquerading as T3",
    );
    for (const task of report.tasks)
      for (const trial of task.trials) {
        const pair = manifest.plan.find((item) => item.id === trial.pairId);
        requireValue(
          pair && pair.taskId === task.id && pair.history === history,
          "Unpaired task evidence",
        );
        requireValue(task.graderHash === report.hashes.grader, "Mismatched trial grader");
        requireValue(
          task.fixtureHash ===
            frozenInputs(pair.history).find((item) => item.taskId === task.id)!.hash,
          "Mismatched trial fixture",
        );
      }
    for (const artifact of report.artifacts) {
      const bytes = await readFile(path.join(directory, "raw", `${artifact.sha256}.json`));
      requireValue(
        bytes.length === artifact.bytes && bytesHash(bytes) === artifact.sha256,
        "Raw evidence digest mismatch",
      );
    }
    requireValue(
      report.artifacts.some(
        (artifact) => artifact.kind === "build" && artifact.sha256 === report.build.artifactHash,
      ),
      "Build artifact missing",
    );
    const inventory = JSON.parse(
      await readFile(path.join(directory, "raw", `${report.build.artifactHash}.json`), "utf8"),
    );
    requireValue(
      inventory.commit === report.build.commit &&
        inventory.parentCommit === report.build.parentCommit &&
        inventory.fixedReleaseCommit === report.build.fixedReleaseCommit &&
        inventory.dependencyLock === report.hashes.dependencyLock,
      "Forged source/build identity",
    );
    requireValue(
      report.artifacts.some((artifact) => artifact.sha256 === contentDigest(manifest)),
      "Readable manifest is not bound to raw evidence",
    );
    for (const usage of report.usage) {
      const trace = report.traces.find((item) => item.id === usage.traceId)!;
      const events = JSON.parse(
        await readFile(path.join(directory, "raw", `${trace.artifactHash}.json`), "utf8"),
      ) as VersusEvent[];
      const source = events.find(
        (event) =>
          event.source === "provider-gateway" &&
          event.kind === "usage" &&
          event.data.id === usage.requestId,
      )?.data as unknown as GatewayRequest | undefined;
      requireValue(
        source && source.requestHash === usage.requestHash && source.purpose === usage.purpose,
        "Usage lacks matching raw observation",
      );
      for (const key of USAGE_CATEGORIES) {
        const expected = source.authoritative ? source.usage[key] : null;
        requireValue(
          usage.categories[key].value === expected,
          "Missing usage category disguised as zero or altered",
        );
        if (expected !== null)
          requireValue(
            usage.categories[key].provenance?.kind ===
              (manifest.mode === "live" ? "provider-live" : "virtual") &&
              usage.categories[key].provenance?.sourceHash === trace.artifactHash,
            "Usage source or tier forged",
          );
      }
    }
  }
}
