import { createHash } from "node:crypto";
import {
  canonicalRunnerJobRequest,
  RUNNER_JOB_ACTIVE_STATES,
  RUNNER_LIMITS,
  RunnerJobRequestSchema,
  type Runner,
  type RunnerEnvironment,
  type RunnerJobCleanupState,
  type RunnerJobPhase,
  type RunnerJobRequest,
  type RunnerJobState,
  type RunnerKind,
  type RunnerLimits,
} from "@ardurbot/contracts";

/**
 * Pure admission and transition policy for runner jobs. No database, no
 * transport, no side effects: the caller supplies every fact (runner
 * registration, resolved sharing, environment, request, prior job for the
 * operation key) and this module decides. Admission failure never falls back
 * to a bot's home or another runner.
 */

/** Why a job request was refused. Stable, machine-readable, no host detail. */
export type RunnerAdmissionRefusalCode =
  | "runner-not-found"
  | "wrong-space"
  | "runner-disabled"
  | "runner-draining"
  | "runner-retired"
  | "sharing-disabled"
  | "not-shared"
  | "unsupported-kind"
  | "environment-not-found"
  | "environment-unsupported"
  | "environment-unverified"
  | "image-identity-mismatch"
  | "image-not-resolved"
  | "engine-mismatch"
  | "probe-stale"
  | "runner-unreachable"
  | "bad-path"
  | "input-too-large"
  | "too-many-input-files"
  | "input-file-too-large"
  | "too-many-outputs"
  | "time-cap-exceeded"
  | "resources-exceed-limits"
  | "secrets-unsupported"
  | "goal-jobs-unsupported"
  | "operation-key-conflict"
  | "slot-occupied"
  | "daily-job-limit"
  | "daily-time-limit"
  | "capacity";

export type RunnerAdmissionRefusal = {
  code: RunnerAdmissionRefusalCode;
  message: string;
};

export type RunnerAdmissionView = {
  /** The space the request is admitted under. */
  spaceId: string;
  /** The runner as stored. */
  runner: Runner;
  /** Sharing resolved for the requesting bot: an explicit allow, deny, or nothing. */
  botAccess: "allow" | "deny" | "none";
  /** The environment the request names. */
  environment: RunnerEnvironment;
  /** Engine identity the connection currently resolves to, for mismatch detection. */
  engine: { kind: RunnerKind; connectionRevision: number };
  /** Image digest the caller bound when it resolved the request, if any. */
  boundImageDigest: string | null;
  /** The job already admitted under this operation key, if any. */
  existingJob: { id: string; requestHash: string; state: RunnerJobState } | null;
  /** Active jobs already holding this bot's execution slot. */
  activeBotSlotJobs: number;
  /** Jobs this runner started today (UTC window). */
  jobsStartedToday: number;
  /** Runner milliseconds consumed today (UTC window). */
  runnerMillisUsedToday: number;
  /** True when the request originates from goal machinery, which R1 rejects. */
  goalOrigin: boolean;
  now: Date;
};

export type RunnerAdmissionDecision =
  | {
      ok: true;
      replay: false;
      requestHash: string;
      durationSeconds: number;
      resources: { cpuMillis: number; memoryBytes: number; diskBytes: number };
    }
  | {
      /** Retry of the same operation key with the identical canonical request. */
      ok: true;
      replay: true;
      requestHash: string;
      existingJobId: string;
    }
  | ({ ok: false } & RunnerAdmissionRefusal);

/** Parse and validate a job request; throws on invalid shape. */
export function parseRunnerJobRequest(input: unknown): RunnerJobRequest {
  return RunnerJobRequestSchema.parse(input);
}

/** Hash of the canonical request. Any argument change produces a different hash. */
export function runnerJobRequestHash(request: RunnerJobRequest): string {
  return createHash("sha256").update(canonicalRunnerJobRequest(request)).digest("hex");
}

/**
 * Admission. Checks run in a fixed order so refusals are deterministic: scope
 * and runner state, sharing, engine identity, environment identity, paths and
 * sizes, time and daily caps, then operation-key replay and the bot slot.
 */
export function admitRunnerJob(
  request: RunnerJobRequest,
  view: RunnerAdmissionView,
): RunnerAdmissionDecision {
  const { runner, environment, limits } = { ...view, limits: view.runner.limits };

  if (runner.spaceId !== view.spaceId)
    return refusal("wrong-space", "This runner is not available in this space.");
  if (runner.retiredAt !== null) return refusal("runner-retired", "This runner was removed.");
  if (runner.admissionState === "disabled")
    return refusal("runner-disabled", "This runner is disabled.");
  if (runner.admissionState === "paused")
    return refusal("runner-disabled", "This runner is paused.");
  if (runner.admissionState === "draining")
    return refusal("runner-draining", "This runner is draining and accepts no new jobs.");

  // Sharing: the global switch beats everything; explicit deny beats any allow.
  if (!runner.sharingEnabled)
    return refusal("sharing-disabled", "This runner is not shared with this bot.");
  if (view.botAccess === "none" || view.botAccess === "deny")
    return refusal("not-shared", "This runner is not shared with this bot.");

  // R1 is Docker-kind only; the connection's engine must still match the
  // registration, at the same connection revision.
  if (runner.kind !== "docker")
    return refusal("unsupported-kind", "Only Docker runners are available in this release.");
  if (view.engine.kind !== runner.kind)
    return refusal("engine-mismatch", "The saved connection no longer matches this runner's engine.");
  if (view.engine.connectionRevision !== runner.connection.revision)
    return refusal("engine-mismatch", "The saved connection changed since this runner was registered.");

  // Environment: must belong to this runner, be in its probed catalog, be
  // verified, and carry the immutable image identity it was probed with.
  if (environment.runnerId !== runner.id)
    return refusal("environment-not-found", "Choose an environment for this runner.");
  if (!runner.capabilities.environments.includes(environment.id))
    return refusal("environment-unsupported", "This runner cannot run the selected environment.");
  if (environment.verifiedAt === null)
    return refusal("environment-unverified", "This environment has not been tested yet.");
  if (environment.kind === "image") {
    if (environment.resolvedImageId === null && environment.resolvedDigest === null)
      return refusal("image-not-resolved", "This environment's image has not been resolved yet.");
    if (
      view.boundImageDigest !== null &&
      environment.resolvedDigest !== null &&
      view.boundImageDigest !== environment.resolvedDigest
    )
      return refusal("image-identity-mismatch", "This environment's image changed since it was tested.");
  }

  // Probe freshness: expired probes and unreachable or unknown runners never admit.
  if (runner.reachability === "unreachable")
    return refusal("runner-unreachable", "This runner is not reachable.");
  if (runner.reachability === "unknown" || runner.probeExpiresAt === null)
    return refusal("probe-stale", "This runner has not been tested yet.");
  if (Date.parse(runner.probeExpiresAt) <= view.now.getTime())
    return refusal("probe-stale", "This runner has not been tested recently.");

  // Input bounds. The request schema rejects bad shapes and per-file ceilings;
  // admission re-checks the aggregate limits from the runner's policy.
  const totalInputBytes = request.filesIn.reduce((sum, file) => sum + file.bytes, 0);
  if (request.filesIn.length > RUNNER_LIMITS.maxInputFiles)
    return refusal("too-many-input-files", "Too many input files.");
  if (totalInputBytes > limits.maxInputBytes)
    return refusal("input-too-large", "The job inputs are too large.");
  for (const file of request.filesIn)
    if (file.bytes > RUNNER_LIMITS.maxInputFileBytes)
      return refusal("input-file-too-large", "An input file is too large.");
  if (request.filesOut.length > limits.maxArtifactCount)
    return refusal("too-many-outputs", "Too many requested output files.");

  // R1 rejects goal-origin jobs and secret grants outright.
  if (view.goalOrigin)
    return refusal("goal-jobs-unsupported", "Runner jobs are not available for goals in this release.");
  if (request.secretGrants.length > 0)
    return refusal("secrets-unsupported", "Runner jobs cannot use secrets in this release.");

  // Time cap: the schema already bounds the request to the R1 cap; the
  // runner's own, possibly stricter, cap applies too.
  if (request.timeoutSeconds > limits.maxDurationSeconds)
    return refusal("time-cap-exceeded", "The requested duration exceeds this runner's limit.");

  const cpuMillis = request.resources?.cpuMillis ?? limits.cpuMillis;
  const memoryBytes = request.resources?.memoryBytes ?? limits.memoryBytes;
  const diskBytes = request.resources?.diskBytes ?? limits.diskBytes;
  if (cpuMillis > limits.cpuMillis || memoryBytes > limits.memoryBytes || diskBytes > limits.diskBytes)
    return refusal("resources-exceed-limits", "This runner cannot enforce the requested limit.");

  // Daily caps. Cancellations and failed launches count; retries never reset them.
  if (view.jobsStartedToday >= limits.maxJobsPerDay)
    return refusal("daily-job-limit", "This runner reached its daily job limit.");
  if (view.runnerMillisUsedToday >= limits.maxRunnerSecondsPerDay * 1000)
    return refusal("daily-time-limit", "This runner reached its daily runner-time limit.");

  // Operation key: identical canonical request replays its job; a different
  // request under the same key is a conflict, never a silent second job.
  if (view.existingJob) {
    const requestHash = runnerJobRequestHash(request);
    if (view.existingJob.requestHash === requestHash)
      return { ok: true, replay: true, requestHash, existingJobId: view.existingJob.id };
    return refusal(
      "operation-key-conflict",
      "This request key was already used for a different job.",
    );
  }

  // One active job per bot execution slot, regardless of which runner holds it.
  if (view.activeBotSlotJobs > 0)
    return refusal("slot-occupied", "This bot already has a runner job in flight.");

  return {
    ok: true,
    replay: false,
    requestHash: runnerJobRequestHash(request),
    durationSeconds: request.timeoutSeconds,
    resources: { cpuMillis, memoryBytes, diskBytes },
  };
}

function refusal(code: RunnerAdmissionRefusalCode, message: string): RunnerAdmissionDecision {
  return { ok: false, code, message };
}

/**
 * Job state machine. A move is legal only along these edges; Stop is accepted
 * at every non-terminal stage.
 *
 *  queued -> staging -> running -> collecting -> cleaning -> finished
 *  any active state -> failed (engine/image/timeout/worker loss)
 *  any active state -> cancelled (Stop confirmed)
 *  staging/running -> cleaning (restart reconciliation of an orphaned job)
 */
const TRANSITIONS: Record<RunnerJobState, RunnerJobState[]> = {
  queued: ["staging", "cleaning", "failed", "cancelled"],
  staging: ["running", "cleaning", "failed", "cancelled"],
  running: ["collecting", "cleaning", "failed", "cancelled"],
  collecting: ["cleaning", "failed", "cancelled"],
  cleaning: ["finished", "failed", "cancelled"],
  finished: [],
  failed: [],
  cancelled: [],
};

/** States that hold the bot execution slot; terminal states release it. */
export function runnerJobHoldsSlot(state: RunnerJobState): boolean {
  return (RUNNER_JOB_ACTIVE_STATES as readonly string[]).includes(state);
}

export type RunnerTransitionCheck = { ok: true } | { ok: false; reason: string };

export function canTransition(from: RunnerJobState, to: RunnerJobState): RunnerTransitionCheck {
  if (from === to) return { ok: false, reason: "same-state" };
  const allowed = TRANSITIONS[from];
  if (!allowed) return { ok: false, reason: "unknown-state" };
  if (!allowed.includes(to)) return { ok: false, reason: "illegal-transition" };
  return { ok: true };
}

/** The phase expected alongside each state in the happy path. */
export const RUNNER_STATE_PHASE: Record<RunnerJobState, RunnerJobPhase> = {
  queued: "waiting-capacity",
  staging: "staging",
  running: "executing",
  collecting: "collecting",
  cleaning: "finished",
  finished: "finished",
  failed: "finished",
  cancelled: "finished",
};

export type RunnerStopInput = {
  state: RunnerJobState;
  /** Whether the provider confirmed the job's process/container is gone. */
  terminationConfirmed: boolean;
  /** Whether the job was ever dispatched to a provider. */
  dispatched: boolean;
};

export type RunnerStopOutcome = {
  /** A durable cancel request is always recorded before any transport delivery. */
  cancelRequested: boolean;
  state: RunnerJobState;
  phase: RunnerJobPhase;
  /** True only when termination is confirmed absent, never from a signal alone. */
  cancelConfirmed: boolean;
  cleanupState: RunnerJobCleanupState;
};

/**
 * Stop at every stage. A queued, never-dispatched job cancels immediately.
 * A dispatched job records the request and confirms only when the provider
 * confirms absence; without confirmation the job stays visibly cancelling,
 * never "cancelled" from a dropped client alone.
 */
export function stopRunnerJob(input: RunnerStopInput): RunnerStopOutcome {
  if (!runnerJobHoldsSlot(input.state))
    return {
      cancelRequested: false,
      state: input.state,
      phase: RUNNER_STATE_PHASE[input.state],
      cancelConfirmed: input.state === "cancelled",
      cleanupState: "pending",
    };
  if (!input.dispatched || input.state === "queued")
    return {
      cancelRequested: true,
      state: "cancelled",
      phase: "finished",
      cancelConfirmed: true,
      // Nothing was ever launched, so there is no provider resource to clean.
      cleanupState: input.dispatched ? "pending" : "clean",
    };
  if (input.terminationConfirmed)
    return {
      cancelRequested: true,
      state: "cancelled",
      phase: "finished",
      cancelConfirmed: true,
      cleanupState: "pending",
    };
  return {
    cancelRequested: true,
    state: input.state,
    phase: "cancelling",
    cancelConfirmed: false,
    cleanupState: "pending",
  };
}

/**
 * Cleanup completion. Idempotent: confirming an already-clean job changes
 * nothing, and a failed cleanup never rewrites the command outcome — the
 * cleanup debt stays visible for retry.
 */
export function confirmRunnerCleanup(
  current: RunnerJobCleanupState,
  outcome: "clean" | "failed",
): { cleanupState: RunnerJobCleanupState; changed: boolean } {
  if (current === "clean") return { cleanupState: "clean", changed: false };
  if (outcome === "failed") return { cleanupState: "failed", changed: current !== "failed" };
  return { cleanupState: "clean", changed: true };
}

/** Absolute allocation deadline: staging + command + collection windows. */
export function runnerJobDeadline(options: {
  dispatchedAt: Date;
  durationSeconds: number;
}): Date {
  return new Date(
    options.dispatchedAt.getTime() +
      (RUNNER_LIMITS.stagingSeconds +
        options.durationSeconds +
        RUNNER_LIMITS.artifactCollectionSeconds) *
        1000,
  );
}

/**
 * Restart reconciliation. An orphaned running/staging/collecting job is not
 * blindly retried: it is marked for cleanup under a new fence. An ambiguous
 * launch never issues a second provider effect.
 */
export type ReconcileAction = "reattach" | "cleanup" | "none";

export function reconcileRunnerJobOnRestart(input: {
  state: RunnerJobState;
  phase: RunnerJobPhase;
  leaseExpiresAt: Date | null;
  now: Date;
}): { action: ReconcileAction; state: RunnerJobState; phase: RunnerJobPhase } {
  if (!runnerJobHoldsSlot(input.state) || input.state === "queued")
    return { action: "none", state: input.state, phase: input.phase };
  const leaseExpired =
    input.leaseExpiresAt === null || input.leaseExpiresAt.getTime() <= input.now.getTime();
  if (!leaseExpired) return { action: "reattach", state: input.state, phase: input.phase };
  return { action: "cleanup", state: "cleaning", phase: "reconciling" };
}

/** Runner kinds usable at R1. */
export const SUPPORTED_RUNNER_KINDS: readonly RunnerKind[] = ["docker"];

export function runnerKindSupported(kind: RunnerKind): boolean {
  return SUPPORTED_RUNNER_KINDS.includes(kind);
}

/** Effective limits clamped to the R1 duration ceiling; used for policy snapshots. */
export function clampRunnerLimits(limits: RunnerLimits): RunnerLimits {
  return { ...limits, maxDurationSeconds: Math.min(limits.maxDurationSeconds, RUNNER_LIMITS.maxDurationSeconds) };
}
