import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { contentDigest } from "../scoreboard/manifest.js";
import type { TaskContract } from "../scoreboard/tasks/catalog.js";
import { getTask, immutable } from "../scoreboard/tasks/catalog.js";
import type { Emit, TrialArtifacts, VersusAdapter, VersusEvent } from "./adapters/types.js";
import type { Budget, Limits } from "./budget.js";
import { BudgetLedger } from "./budget.js";
import { HERMES_CONTAINER_REVISION, HERMES_IMAGE } from "./containers/policy.js";
import type { inspectImage } from "./containers/session.js";
import type { EvidenceTrial } from "./evidence.js";
import { BYTE_LIMIT_REFUSALS, startGateway } from "./gateway.js";
import { blindPacket, gradeBlind } from "./grading.js";
import type { OwnedDirectory } from "./isolation.js";
import { createTrialDirectory, destroyOwnedDirectory } from "./isolation.js";
import type { Product } from "./manifest.js";
import { frozenInputs, HERMES_RELEASE_REVISION, HERMES_RESEARCH_REVISION } from "./manifest.js";
import type { HermesIdentity } from "./provenance.js";
import { sanitize } from "./provenance.js";
import {
  assessContainerCohort,
  inspectLocalRoute,
  readContainerCohortInputs,
  routeFailure,
} from "./qualification.js";
import type { PairedResult, PairPlan } from "./scheduler.js";
import type { ServingWitness } from "./serving.js";

const perRun: Limits = {
  requests: 12,
  logicalInput: 120000,
  output: 12000,
  totalTokens: 132000,
  wallMs: 600000,
  toolCalls: 30,
  descendants: 4,
};
/** The owner-approved canary, recorded 2026-09-25. Live admission runs exactly this and nothing else. */
export const APPROVED_CANARY = immutable({
  model: {
    id: "llama3.1:8b",
    digest: "46e0c10c039e019119339687c3c1757cc81b9da49709a3b3924863ba87ca666e",
    quantization: "Q4_K_M",
  },
  contextSize: 65536,
  tasks: ["task-01", "task-04"],
  repetitions: 1,
  runs: 4,
  perTrial: perRun,
  image: HERMES_IMAGE,
  revision: HERMES_CONTAINER_REVISION,
});

/** Every way a budget differs from the approved canary, one actionable sentence each. */
export function canaryDifferences(budget: Budget) {
  const differences: string[] = [];
  const expect = (same: boolean, difference: string) => {
    if (!same)
      differences.push(
        `Use the canary-budget.json the container cohort planner wrote; ${difference}.`,
      );
  };
  const approved = APPROVED_CANARY;
  expect(!budget.endpoint.paid, "its endpoint is paid, and the approved canary is local and free");
  expect(
    budget.model.id === approved.model.id &&
      budget.model.digest === approved.model.digest &&
      budget.model.quantization === approved.model.quantization,
    `its model differs from the approved ${approved.model.id} ${approved.model.quantization} digest`,
  );
  expect(
    budget.contextSize === approved.contextSize,
    `its context size differs from the approved ${approved.contextSize} tokens`,
  );
  expect(
    contentDigest(budget.perTrial) === contentDigest(approved.perTrial),
    "its per-run limits differ from the approved canary",
  );
  expect(
    Object.entries(approved.perTrial).every(
      ([key, limit]) => budget.global[key as keyof Limits] === limit * approved.runs,
    ),
    `its global limits differ from ${approved.runs} times the approved per-run limits`,
  );
  expect(
    contentDigest(budget.cohort.tasks) === contentDigest(approved.tasks) &&
      budget.cohort.repetitions === approved.repetitions,
    `its tasks differ from the approved ${approved.tasks.join(" and ")}, once each`,
  );
  expect(budget.concurrency === 1, "its concurrency is not one run at a time");
  expect(
    budget.currency.cap === 0 && budget.currency.priceSchedule === null,
    "its spending cap is not zero",
  );
  return differences;
}

/**
 * Live container admission. Approval, the canary pin, the pinned image and the qualified report
 * are checked before the endpoint is contacted; the route is then read with metadata requests
 * only, and the budget must be exactly the one the planner derives from it.
 */
export async function assessLiveContainerGate(input: {
  budget: Budget;
  approval: string | undefined;
  reportPath: string | undefined;
  inspect?: typeof inspectImage;
}) {
  const offlineFailures = [...canaryDifferences(input.budget)];
  const inputs = await readContainerCohortInputs(input.reportPath, input.inspect);
  offlineFailures.push(...inputs.failures);
  // The declared context stands in for the route here, so only the offline gates can fail.
  const offline = assessContainerCohort({
    approval: input.approval,
    report: inputs.report,
    pinnedImage: inputs.pinnedImage,
    preflightFailures: offlineFailures,
    routeContext: input.budget.contextSize,
    architectureMaximum: input.budget.contextSize,
    servingContext: input.budget.contextSize,
  });
  if (!offline.ready)
    return {
      ready: false,
      stage: "offline" as const,
      failures: [...offlineFailures, ...offline.failures],
      pinnedImage: inputs.pinnedImage,
      gates: offline.gates,
      route: null,
    };
  const failures: string[] = [];
  let route: Awaited<ReturnType<typeof inspectLocalRoute>> | null = null;
  try {
    route = await inspectLocalRoute({
      origin: input.budget.endpoint.origin,
      model: input.budget.model.id,
      digest: input.budget.model.digest,
      quantization: input.budget.model.quantization,
      contextSize: input.budget.contextSize,
    });
  } catch (error) {
    failures.push(routeFailure(error));
  }
  const assessment = assessContainerCohort({
    approval: input.approval,
    report: inputs.report,
    pinnedImage: inputs.pinnedImage,
    preflightFailures: failures,
    routeContext: route?.budget.contextSize ?? null,
    architectureMaximum: typeof route?.maximumContext === "number" ? route.maximumContext : null,
    servingContext: route?.effectiveContext ?? null,
  });
  failures.push(...assessment.failures);
  if (route && contentDigest(route.budget) !== contentDigest(input.budget))
    failures.push(
      "Re-run container cohort planning and pass the canary-budget.json it writes; this budget does not match the served model's metadata.",
    );
  return {
    ready: failures.length === 0,
    stage: "route" as const,
    failures,
    pinnedImage: inputs.pinnedImage,
    gates: assessment.gates,
    route,
  };
}

/** The container cohort's Hermes identity. The installed native interpreter is a different cohort. */
export function containerHermesIdentity(
  image: { id: string; revision: string | null } | null,
): HermesIdentity {
  return {
    available: image !== null,
    requestedRevision: HERMES_RESEARCH_REVISION,
    releaseRevision: HERMES_RELEASE_REVISION,
    actualRevision: image?.revision ?? null,
    parentRevision: null,
    expectedRevision: HERMES_CONTAINER_REVISION,
    revisionMatches: image?.revision === HERMES_CONTAINER_REVISION,
    binaryHash: null,
    sourceDirty: null,
    dirtyStatusHash: null,
    sourceHashes: [],
    sourceHashCoverage: image ? `pinned-container-image ${image.id}` : "pinned-image-not-inspected",
  };
}

export interface LiveTrialSetup {
  id: string;
  product: Product;
  task: TaskContract;
  directory: OwnedDirectory;
  ledger: BudgetLedger;
  emit: Emit;
  /** The route the serving witness attested for this trial, or null once any attestation failed. */
  observedRoute: () => { endpoint: string; model: string; digest: string } | null;
}
/** Composes one product adapter per trial; the runner owns admission, deadline and grading. */
export interface LiveProducts {
  create(setup: LiveTrialSetup): Promise<{ adapter: VersusAdapter; release?: () => Promise<void> }>;
  /** Installs the trial's network confinement around product execution; returns its undo. */
  confine?: () => () => void;
  /** What the composition is, retained with the run. */
  describe?: () => Record<string, unknown>;
  close(): Promise<void>;
}
export type LiveClassification =
  | "completed"
  | "cap"
  | "deadline"
  | "serving-refused"
  | "invalid-infrastructure"
  | "not-run";

/** Only a budget counter or the wire-size envelope is a cap; wall time is a deadline. */
function isCap(reason: string) {
  return (
    (reason.startsWith("budget-exhausted:") && reason !== "budget-exhausted: wall time") ||
    (BYTE_LIMIT_REFUSALS as readonly string[]).includes(reason)
  );
}

/** How long a cancelled adapter may take to stop, and to be collected, before the runner moves on. */
const STOP_GRACE_MS = 15000;

async function within<T>(work: Promise<T>, ms: number, message: string) {
  const controller = new AbortController();
  try {
    return await Promise.race([
      work,
      delay(ms, undefined, { signal: controller.signal }).then(() => {
        throw new Error(message);
      }),
    ]);
  } finally {
    controller.abort();
  }
}

/** Submit until the product finishes or the deadline aborts it; a stopped trial is never retried. */
async function submitUntil(adapter: VersusAdapter, signal: AbortSignal) {
  const submitted = adapter.submit();
  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.race([submitted, aborted]);
  if (!signal.aborted) return;
  await adapter.cancel().catch(() => undefined);
  await within(submitted, STOP_GRACE_MS, "The product did not stop after the deadline").catch(
    () => undefined,
  );
}

function ungraded(id: string, reason: string) {
  return {
    packetId: `blind-${contentDigest(id).slice(0, 24)}`,
    passed: false,
    uninspected: true,
    criticalPassed: false,
    withinDeadline: false,
    reasons: [reason],
    checks: {},
    reviewerAgreement: null,
    humanRubric: "not-measured",
  };
}

/**
 * Runs the planned pairs in their fixed seeded order, one trial at a time, through one budget
 * gateway whose counters span every trial. Every trial is retained; none is retried or replaced.
 */
export async function runLiveTrials(options: {
  budget: Budget;
  plan: PairPlan[];
  graderHash: string;
  products: LiveProducts;
  serving: ServingWitness;
  root: string;
}) {
  const { budget, serving } = options;
  const ledger = new BudgetLedger(budget);
  const gateway = await startGateway({
    budget,
    ledger,
    evidenceKind: "provider-live",
    serving,
  });
  const origin = performance.now();
  const trials: EvidenceTrial[] = [];
  const results: PairedResult[] = [];
  const outcomes: { trialId: string; classification: LiveClassification; reason: string }[] = [];
  // Once the budget can admit nothing more, every remaining run is recorded as not run.
  let halted: string | null = null;
  try {
    for (const pair of options.plan)
      for (const product of pair.order) {
        const id = `live-${pair.id}-${product}`;
        const task = getTask(pair.taskId);
        const fixtureHash = frozenInputs(pair.history).find(
          (item) => item.taskId === task.id,
        )!.hash;
        const events: VersusEvent[] = [];
        const emit: Emit = (kind, source, data) =>
          events.push({
            sequence: events.length,
            trialId: id,
            kind,
            source,
            clock: "monotonic",
            at: performance.now() - origin,
            data,
          });
        const started = performance.now();
        let classification: LiveClassification = "completed";
        let reason = "completed";
        let artifacts: TrialArtifacts | null = null;
        let admitted = false;
        if (halted) {
          classification = "not-run";
          reason = `not run: ${halted}`;
          emit("diagnostic", "provider-gateway", { boundary: "controller", reason });
        } else
          try {
            await gateway.admit(id);
            admitted = true;
          } catch (error) {
            classification = "serving-refused";
            reason = sanitize(error instanceof Error ? error.message : String(error));
            emit("diagnostic", "provider-gateway", { boundary: "trial-admission", reason });
          }
        let deadline: { timerMs: number; boundBy: "per-run" | "global" } | null = null;
        let deadlineHit = false;
        let failure: string | null = null;
        let protocolRefusals: string[] = [];
        if (admitted) {
          const control = new AbortController();
          let directory: OwnedDirectory | null = null;
          let timer: NodeJS.Timeout | undefined;
          let revoked = false;
          const revokeProvider = () => {
            if (revoked) return;
            revoked = true;
            gateway.revoke(id);
            emit("diagnostic", "provider-gateway", {
              boundary: "controller-revoked-trial-capability",
              productPrevention: false,
              remoteBillingStopped: null,
            });
          };
          const observedRoute = () =>
            serving.observations
              .filter((observation) => observation.trialId === id)
              .every((observation) => observation.admitted)
              ? {
                  endpoint: budget.endpoint.origin,
                  model: budget.model.id,
                  digest: budget.model.digest,
                }
              : null;
          let created: Awaited<ReturnType<LiveProducts["create"]>> | null = null;
          let restore: (() => void) | null = null;
          try {
            // A poisoned ledger or an exhausted global wall refuses here, inside the trial.
            const wall = ledger.remainingWall(id);
            deadline = { timerMs: Math.floor(wall.ms), boundBy: wall.boundBy };
            directory = await createTrialDirectory(options.root);
            timer = setTimeout(() => {
              deadlineHit = true;
              emit("diagnostic", "provider-gateway", {
                boundary: "controller-wall-deadline",
                ...deadline,
                productPrevention: false,
              });
              control.abort();
            }, deadline.timerMs);
            created = await options.products.create({
              id,
              product,
              task,
              directory,
              ledger,
              emit,
              observedRoute,
            });
            restore = options.products.confine?.() ?? null;
            await created.adapter.prepare({
              id,
              pairId: pair.id,
              task,
              workspace: directory.workspace,
              stateDirectory: directory.state,
              budget,
              // Runtime purposes are not observed at this boundary; they are never labeled main.
              providerUrl: gateway.capability(id, null, emit),
              revokeProvider,
              brokerUrl: "unused",
              emit,
              signal: control.signal,
            });
            await submitUntil(created.adapter, control.signal);
            artifacts = await within(
              created.adapter.collect(),
              STOP_GRACE_MS,
              "The trial's artifacts could not be collected",
            );
          } catch (error) {
            failure = sanitize(error instanceof Error ? error.message : String(error));
          } finally {
            restore?.();
            clearTimeout(timer);
            revokeProvider();
            await created?.adapter.destroy().catch((error: unknown) => {
              failure ??= sanitize(`Cleanup: ${String(error)}`);
            });
            await created?.release?.().catch((error: unknown) => {
              failure ??= sanitize(`Cleanup: ${String(error)}`);
            });
            if (directory) await destroyOwnedDirectory(directory).catch(() => undefined);
          }
          const refusals = [
            ...ledger.refusals.filter((refusal) => refusal.trialId === id),
            ...gateway.refusals.filter((refusal) => refusal.trialId === id),
          ].map((refusal) => refusal.reason);
          const capReason = refusals.find(isCap);
          // Route drift, unsupported operations, parse errors and late requests after revocation
          // are retained as diagnostics; they never turn a completed run into a cap.
          protocolRefusals = gateway.refusals
            .filter((refusal) => refusal.trialId === id)
            .map((refusal) => refusal.reason)
            .filter((item) => !isCap(item) && !item.startsWith("Serving state refused"));
          const drift = serving.observations.find(
            (observation) => observation.trialId === id && !observation.admitted,
          );
          const overrun = gateway.requests.some(
            (request) => request.trialId === id && request.missingReason === "invalid-trial",
          );
          if (!deadline) {
            const stop = ledger.stopped() ?? `The run could not start: ${failure}.`;
            halted = stop;
            classification = "invalid-infrastructure";
            reason = `invalid-infrastructure: ${stop}`;
          } else if (drift) {
            classification = "invalid-infrastructure";
            reason = `invalid-infrastructure: serving state changed during the trial (${drift.reason})`;
          } else if (overrun) {
            classification = "invalid-infrastructure";
            reason =
              "invalid-infrastructure: The endpoint reported more tokens than the request reserved; re-qualify the endpoint before another canary.";
          } else if (deadlineHit) {
            classification = "deadline";
            reason = `deadline: stopped at ${deadline.timerMs} ms, bound by the ${deadline.boundBy === "global" ? "remaining global wall limit" : "per-run wall limit"}`;
          } else if (artifacts?.observation.terminal === "timed-out") {
            classification = "deadline";
            reason = `deadline: ${task.deadlineMs} ms task deadline`;
          } else if (capReason) {
            classification = "cap";
            reason = capReason;
          } else if (failure || !artifacts) {
            classification = "invalid-infrastructure";
            reason = `invalid-infrastructure: ${failure ?? "no artifacts were collected"}`;
          }
          if (failure) emit("diagnostic", "provider-gateway", { boundary: "controller", failure });
        }
        const packet = artifacts
          ? blindPacket({
              taskId: task.id,
              trialId: id,
              fixtureHash,
              graderHash: options.graderHash,
              observation: artifacts.observation,
            })
          : null;
        const graded = packet
          ? gradeBlind(packet, { fixtureHash, graderHash: options.graderHash })
          : ungraded(id, reason);
        if (graded.uninspected && classification === "completed") {
          classification = "invalid-infrastructure";
          reason = `invalid-infrastructure: ${graded.reasons.join("; ")}`;
        }
        const grade = { ...graded, withinDeadline: graded.withinDeadline ?? false };
        const terminal = artifacts?.observation.terminal ?? "uncertain";
        const outcome: EvidenceTrial["outcome"] = grade.passed
          ? "success"
          : classification === "deadline"
            ? "timed-out"
            : ["serving-refused", "invalid-infrastructure", "not-run"].includes(classification)
              ? "uncertain"
              : terminal === "completed"
                ? "failed"
                : terminal;
        const requests = gateway.requests.filter((request) => request.trialId === id);
        const elapsedMs = performance.now() - started;
        emit("terminal", "provider-gateway", { classification, reason, outcome });
        outcomes.push({ trialId: id, classification, reason });
        trials.push({
          product,
          taskId: task.id,
          trialId: id,
          sessionId: artifacts?.sessionId ?? `session-${contentDigest(id).slice(0, 16)}`,
          traceId: `trace-${contentDigest(id).slice(0, 16)}`,
          pairId: pair.id,
          fixtureHash,
          graderHash: options.graderHash,
          outcome,
          grade,
          events,
          raw: {
            packet,
            grade,
            clock: "monotonic",
            classification,
            reason,
            elapsedMs,
            deadline,
            outcomeReason: artifacts?.outcomeReason ?? null,
            userTtftMissingReason: artifacts?.userTtftMissingReason ?? null,
            requests,
            serving: serving.observations.filter((observation) => observation.trialId === id),
            refusals: {
              ledger: ledger.refusals.filter((refusal) => refusal.trialId === id),
              gateway: gateway.refusals.filter((refusal) => refusal.trialId === id),
              protocol: protocolRefusals,
            },
            liveAgentSuccess: grade.passed,
          },
        });
        results.push({
          pairId: pair.id,
          product,
          taskId: task.id,
          cluster: pair.cluster,
          accepted: grade.passed,
          criticalPassed: grade.criticalPassed,
          reason,
          tier: "T3",
          elapsedMs,
          logicalInput:
            requests.length > 0 && requests.every((request) => request.authoritative)
              ? requests.reduce((sum, request) => sum + (request.usage.logicalInput ?? 0), 0)
              : null,
          cost: null,
        });
      }
    const count = (kind: LiveClassification) =>
      outcomes.filter((item) => item.classification === kind).length;
    return {
      trials,
      results,
      budget,
      budgetEvidence: {
        ...ledger.snapshot(),
        gatewayRequests: gateway.requests,
        gatewayRefusals: gateway.refusals,
        serving: serving.observations,
      },
      protocolResults: {
        tier: "T3",
        clock: "monotonic",
        lane: "separately-labeled-Linux-container-cohort",
        order: "manifest-seeded-pairs-serial-concurrency-one",
        plannedRuns: options.plan.reduce((sum, pair) => sum + pair.order.length, 0),
        executedRuns:
          outcomes.length -
          count("serving-refused") -
          count("invalid-infrastructure") -
          count("not-run"),
        classifications: {
          completed: count("completed"),
          cap: count("cap"),
          deadline: count("deadline"),
          servingRefused: count("serving-refused"),
          invalidInfrastructure: count("invalid-infrastructure"),
          notRun: count("not-run"),
        },
        outcomes,
        forwardedModelRequests: gateway.requests.length,
        products: options.products.describe?.() ?? null,
        retries: 0,
        replacements: 0,
      },
    };
  } finally {
    await gateway.close();
    await options.products.close();
  }
}
export type LiveRun = Awaited<ReturnType<typeof runLiveTrials>>;

/**
 * 0: every planned run executed and its evidence validated. 1: every run executed, and a cap or
 * the wall deadline stopped at least one (a measured finding). 2: anything refused or incomplete.
 */
export function liveVerdict(run: Pick<LiveRun, "protocolResults" | "results">) {
  const { plannedRuns, executedRuns, classifications } = run.protocolResults;
  const code =
    executedRuns < plannedRuns || run.results.length < plannedRuns
      ? 2
      : classifications.cap + classifications.deadline > 0
        ? 1
        : 0;
  const accepted = (product: Product) =>
    `${product} ${run.results.filter((result) => result.product === product && result.accepted).length}/${run.results.filter((result) => result.product === product).length}`;
  return {
    code,
    summary: `Live canary: ${executedRuns}/${plannedRuns} runs executed; accepted ${accepted("ardur")}, ${accepted("hermes")}; caps ${classifications.cap}, deadlines ${classifications.deadline}, invalid infrastructure ${classifications.invalidInfrastructure + classifications.servingRefused}, not run ${classifications.notRun}; model requests ${run.protocolResults.forwardedModelRequests}; exit ${code}.`,
  };
}
