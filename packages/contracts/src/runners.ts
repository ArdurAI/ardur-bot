import { z } from "zod";

/**
 * Runner contracts for bounded work away from a bot's home.
 *
 * R1 covers storage and policy only: explicit runner choice, Docker-kind
 * registrations, bounded regular-file inputs, no secrets, no ports, and no
 * automatic pull/build. Nothing here admits live execution by itself.
 */

export const RUNNER_KINDS = ["docker", "podman", "kubernetes", "ssh"] as const;
export const RunnerKindSchema = z.enum(RUNNER_KINDS);
export type RunnerKind = z.infer<typeof RunnerKindSchema>;

export const RunnerReachabilitySchema = z.enum(["unknown", "reachable", "unreachable"]);
export type RunnerReachability = z.infer<typeof RunnerReachabilitySchema>;

export const RunnerAdmissionStateSchema = z.enum(["disabled", "enabled", "paused", "draining"]);
export type RunnerAdmissionState = z.infer<typeof RunnerAdmissionStateSchema>;

export const RunnerSupportSchema = z.enum(["supported", "unsupported", "unknown"]);
export type RunnerSupport = z.infer<typeof RunnerSupportSchema>;

export const RunnerEnvironmentKindSchema = z.enum(["image", "host"]);
export type RunnerEnvironmentKind = z.infer<typeof RunnerEnvironmentKindSchema>;

export const RUNNER_OS = ["linux", "darwin", "windows", "unknown"] as const;

/** Observed capability report. `unknown` is never treated as supported. */
export const RunnerCapabilitiesSchema = z.object({
  containers: RunnerSupportSchema,
  shell: RunnerSupportSchema,
  files: RunnerSupportSchema,
  ports: RunnerSupportSchema,
  gpu: RunnerSupportSchema,
  networkIsolation: RunnerSupportSchema,
  hardDiskLimit: RunnerSupportSchema,
  processTreeCancellation: RunnerSupportSchema,
  os: z.enum(RUNNER_OS),
  architectures: z.array(z.string().min(1).max(32)).max(16),
  /** IDs of owner-registered, probed environments. */
  environments: z.array(z.string().min(1).max(64)).max(256),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilitiesSchema>;

export function unknownRunnerCapabilities(): RunnerCapabilities {
  return {
    containers: "unknown",
    shell: "unknown",
    files: "unknown",
    ports: "unknown",
    gpu: "unknown",
    networkIsolation: "unknown",
    hardDiskLimit: "unknown",
    processTreeCancellation: "unknown",
    os: "unknown",
    architectures: [],
    environments: [],
  };
}

/** Immutable selector for the connection a runner dispatches through. */
export const RunnerConnectionRefSchema = z.object({
  connectionId: z.string().min(1).max(64),
  /** Logical execution host: the server or a specific paired host. */
  executionHostId: z.string().min(1).max(64).default("server"),
  revision: z.number().int().nonnegative(),
});
export type RunnerConnectionRef = z.infer<typeof RunnerConnectionRefSchema>;

/** R1 governance defaults. Owners may tighten these; nothing may silently widen them. */
export const RUNNER_LIMITS = {
  /** Default admitted command duration. */
  defaultDurationSeconds: 300,
  /** Absolute R1 cap on admitted command duration. */
  maxDurationSeconds: 900,
  /** Separate staging deadline before the command starts. */
  stagingSeconds: 120,
  /** Separate artifact-collection deadline after the command exits. */
  artifactCollectionSeconds: 60,
  maxConcurrentJobs: 1,
  maxQueuedJobs: 20,
  maxQueueSeconds: 900,
  cpuMillis: 2000,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  pids: 256,
  /** Bounded tmpfs workspace, charged against memory. */
  tmpfsBytes: 512 * 1024 * 1024,
  maxInputBytes: 64 * 1024 * 1024,
  maxInputFiles: 10_000,
  maxInputFileBytes: 16 * 1024 * 1024,
  maxArtifactBytes: 64 * 1024 * 1024,
  maxArtifactFiles: 50,
  maxArtifactFileBytes: 16 * 1024 * 1024,
  maxJobsPerDay: 100,
  maxRunnerSecondsPerDay: 3600,
} as const;

export const RunnerLimitsSchema = z.object({
  maxConcurrentJobs: z.number().int().min(1).max(16),
  maxQueuedJobs: z.number().int().min(0).max(1000),
  maxDurationSeconds: z.number().int().min(1).max(RUNNER_LIMITS.maxDurationSeconds),
  maxQueueSeconds: z.number().int().min(1).max(86_400),
  cpuMillis: z.number().int().min(1).max(102_400),
  memoryBytes: z
    .number()
    .int()
    .min(1024 * 1024),
  diskBytes: z
    .number()
    .int()
    .min(1024 * 1024),
  pids: z.number().int().min(1).max(8192),
  maxInputBytes: z.number().int().min(1),
  maxArtifactBytes: z.number().int().min(1),
  maxArtifactCount: z.number().int().min(1),
  maxJobsPerDay: z.number().int().min(1),
  maxRunnerSecondsPerDay: z.number().int().min(1),
  spendMode: z.enum(["owner-managed", "metered", "unknown"]),
  currency: z.string().length(3).nullable(),
  rateMicrosPerMinute: z.number().int().nonnegative().nullable(),
  dailyCostLimitMicros: z.number().int().nonnegative().nullable(),
});
export type RunnerLimits = z.infer<typeof RunnerLimitsSchema>;

/** A runner's advertised limits, clamped to the R1 ceilings where they apply. */
export function defaultRunnerLimits(): RunnerLimits {
  return {
    maxConcurrentJobs: RUNNER_LIMITS.maxConcurrentJobs,
    maxQueuedJobs: RUNNER_LIMITS.maxQueuedJobs,
    maxDurationSeconds: RUNNER_LIMITS.defaultDurationSeconds,
    maxQueueSeconds: RUNNER_LIMITS.maxQueueSeconds,
    cpuMillis: RUNNER_LIMITS.cpuMillis,
    memoryBytes: RUNNER_LIMITS.memoryBytes,
    diskBytes: RUNNER_LIMITS.tmpfsBytes,
    pids: RUNNER_LIMITS.pids,
    maxInputBytes: RUNNER_LIMITS.maxInputBytes,
    maxArtifactBytes: RUNNER_LIMITS.maxArtifactBytes,
    maxArtifactCount: RUNNER_LIMITS.maxArtifactFiles,
    maxJobsPerDay: RUNNER_LIMITS.maxJobsPerDay,
    maxRunnerSecondsPerDay: RUNNER_LIMITS.maxRunnerSecondsPerDay,
    spendMode: "owner-managed",
    currency: null,
    rateMicrosPerMinute: null,
    dailyCostLimitMicros: null,
  };
}

/** Registration record. Probe detail shown to bots never includes endpoints or credential paths. */
export const RunnerSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  ownerUserId: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: RunnerKindSchema,
  connection: RunnerConnectionRefSchema,
  admissionState: RunnerAdmissionStateSchema,
  capabilities: RunnerCapabilitiesSchema,
  capabilitiesObservedAt: z.iso.datetime().nullable(),
  capabilityRevision: z.number().int().nonnegative(),
  reachability: RunnerReachabilitySchema,
  lastProbeAt: z.iso.datetime().nullable(),
  probeExpiresAt: z.iso.datetime().nullable(),
  lastProbeCode: z.string().max(128).nullable(),
  policyRevision: z.number().int().nonnegative(),
  sharingEnabled: z.boolean(),
  defaultAccess: z.enum(["allow", "deny"]),
  protected: z.boolean(),
  limits: RunnerLimitsSchema,
  /** Untrusted plain text; never executable instructions. */
  notes: z.string().max(2000),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().nullable(),
});
export type Runner = z.infer<typeof RunnerSchema>;

/** Owner-defined environment. Revisions are immutable: jobs snapshot what they admitted. */
export const RunnerEnvironmentSchema = z.object({
  id: z.string().min(1).max(64),
  runnerId: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: RunnerEnvironmentKindSchema,
  profileId: z.string().max(64).nullable(),
  requestedImage: z.string().max(512).nullable(),
  resolvedImageId: z.string().max(512).nullable(),
  resolvedDigest: z
    .string()
    .max(128)
    .regex(/^sha256:[a-f0-9]{64}$/)
    .nullable(),
  os: z.enum(RUNNER_OS),
  architecture: z.string().min(1).max(32),
  /** Observed tool versions; never a promise about untested tools. */
  tools: z
    .array(z.object({ name: z.string().min(1).max(64), version: z.string().max(128).nullable() }))
    .max(256),
  dependencyManifestHash: z.string().max(128).nullable(),
  lockfileHash: z.string().max(128).nullable(),
  setupArgv: z.array(z.string().min(1).max(4096)).max(64).nullable(),
  networkMode: z.enum(["none", "dns-only", "egress-approved"]).default("none"),
  revision: z.number().int().positive(),
  verifiedAt: z.iso.datetime().nullable(),
});
export type RunnerEnvironment = z.infer<typeof RunnerEnvironmentSchema>;

export const RunnerRegisterInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  kind: RunnerKindSchema,
  connectionId: z.string().min(1).max(64),
  executionHostId: z.string().min(1).max(64).default("server"),
  environment: z.strictObject({
    name: z.string().trim().min(1).max(80),
    kind: RunnerEnvironmentKindSchema,
    profileId: z.string().max(64).optional(),
    requestedImage: z.string().max(512).optional(),
    networkMode: z.enum(["none", "dns-only", "egress-approved"]).default("none"),
  }),
});
export type RunnerRegisterInput = z.infer<typeof RunnerRegisterInputSchema>;

export const RunnerProbeResultSchema = z.object({
  runnerId: z.string().min(1),
  reachability: RunnerReachabilitySchema,
  capabilities: RunnerCapabilitiesSchema,
  observedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  reasonCode: z.string().max(128).optional(),
});
export type RunnerProbeResult = z.infer<typeof RunnerProbeResultSchema>;

// Constructed with String.raw so no literal control characters appear in source.
const CONTROL_OR_DEL = new RegExp(String.raw`[\0-\x1f\x7f]`);

/**
 * Paths inside a job workspace. Relative, no traversal, no absolute paths, no
 * host file system references, no control characters: a path a model chose
 * never reaches the host.
 */
export const RUNNER_PATH_MAX_LENGTH = 512;
export const RUNNER_PATH_MAX_DEPTH = 32;

export const RunnerFilePathSchema = z
  .string()
  .min(1)
  .max(RUNNER_PATH_MAX_LENGTH)
  .refine((value) => !CONTROL_OR_DEL.test(value), "Control characters are not allowed")
  .refine((value) => !value.includes("\\"), "Backslash paths are not allowed")
  .refine((value) => !value.startsWith("/"), "Absolute paths are not allowed")
  .refine((value) => !value.startsWith("~"), "Home paths are not allowed")
  .refine((value) => !value.includes("//"), "Empty path segments are not allowed")
  .refine((value) => !value.endsWith("/"), "Paths must name a file")
  .refine(
    (value) => value.split("/").every((part) => part !== "." && part !== ".."),
    "Path traversal is not allowed",
  )
  .refine((value) => value.split("/").length <= RUNNER_PATH_MAX_DEPTH, "Path is too deep");
export type RunnerFilePath = z.infer<typeof RunnerFilePathSchema>;

/** Bounded staged input: an existing artifact, or a snapshot of the authorized source workspace. */
export const RunnerJobInputFileSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("artifact"),
    artifactId: z.string().min(1).max(64),
    path: RunnerFilePathSchema,
    bytes: z.number().int().nonnegative(),
  }),
  z.strictObject({
    source: z.literal("workspace-snapshot"),
    workspaceSnapshotId: z.string().min(1).max(64),
    path: RunnerFilePathSchema,
    bytes: z.number().int().nonnegative(),
  }),
]);
export type RunnerJobInputFile = z.infer<typeof RunnerJobInputFileSchema>;

export const RunnerJobOutputFileSchema = z.strictObject({
  path: RunnerFilePathSchema,
  required: z.boolean().default(true),
});
export type RunnerJobOutputFile = z.infer<typeof RunnerJobOutputFileSchema>;

/**
 * A job request. Explicit runner id only in R1. Strict: callers cannot attach
 * identities, endpoints, host paths, mounts, approval ids or any other
 * authority — those come from the authenticated run and saved owner policy.
 */
export const RunnerJobRequestSchema = z.strictObject({
  runnerId: z.string().min(1).max(64),
  environmentId: z.string().min(1).max(64),
  environmentRevision: z.number().int().positive().optional(),
  command: z.strictObject({
    argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
    /** Relative to the staged workspace. */
    cwd: RunnerFilePathSchema.optional(),
  }),
  filesIn: z.array(RunnerJobInputFileSchema).max(RUNNER_LIMITS.maxInputFiles).default([]),
  filesOut: z.array(RunnerJobOutputFileSchema).max(RUNNER_LIMITS.maxArtifactFiles).default([]),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(RUNNER_LIMITS.maxDurationSeconds)
    .default(RUNNER_LIMITS.defaultDurationSeconds),
  resources: z
    .strictObject({
      cpuMillis: z.number().int().min(1).max(RUNNER_LIMITS.cpuMillis).optional(),
      memoryBytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .max(RUNNER_LIMITS.memoryBytes)
        .optional(),
      diskBytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .max(RUNNER_LIMITS.tmpfsBytes)
        .optional(),
    })
    .optional(),
  /** Names already-authorized grants. R1 admission rejects any non-empty list. */
  secretGrants: z.array(z.string().min(1).max(128)).max(16).default([]),
});
export type RunnerJobRequest = z.infer<typeof RunnerJobRequestSchema>;

export function runnerJobRequest(request: RunnerJobRequest): RunnerJobRequest {
  return RunnerJobRequestSchema.parse(request);
}

/**
 * Canonical request form for hashing: stable key order, defaults applied, so
 * the same intent always hashes the same and any argument change does not.
 */
export function canonicalRunnerJobRequest(request: RunnerJobRequest): string {
  const parsed = RunnerJobRequestSchema.parse(request);
  const canonical = {
    runnerId: parsed.runnerId,
    environmentId: parsed.environmentId,
    ...(parsed.environmentRevision === undefined
      ? {}
      : { environmentRevision: parsed.environmentRevision }),
    command: {
      argv: [...parsed.command.argv],
      ...(parsed.command.cwd === undefined ? {} : { cwd: parsed.command.cwd }),
    },
    filesIn: parsed.filesIn.map((file) =>
      file.source === "artifact"
        ? { artifactId: file.artifactId, path: file.path, source: "artifact" }
        : {
            path: file.path,
            source: "workspace-snapshot",
            workspaceSnapshotId: file.workspaceSnapshotId,
          },
    ),
    filesOut: parsed.filesOut.map((file) => ({ path: file.path, required: file.required })),
    resources:
      parsed.resources === undefined
        ? undefined
        : Object.keys(parsed.resources)
            .sort()
            .reduce<Record<string, number>>((acc, key) => {
              const value = parsed.resources?.[key as keyof typeof parsed.resources];
              if (value !== undefined) acc[key] = value;
              return acc;
            }, {}),
    secretGrants: [...parsed.secretGrants],
    timeoutSeconds: parsed.timeoutSeconds,
  };
  return JSON.stringify(canonical);
}

export const RUNNER_JOB_ACTIVE_STATES = [
  "queued",
  "staging",
  "running",
  "collecting",
  "cleaning",
] as const;
export const RUNNER_JOB_TERMINAL_STATES = ["finished", "failed", "cancelled"] as const;
export const RunnerJobStateSchema = z.enum([
  ...RUNNER_JOB_ACTIVE_STATES,
  ...RUNNER_JOB_TERMINAL_STATES,
]);
export type RunnerJobState = z.infer<typeof RunnerJobStateSchema>;
export type RunnerJobTerminalState = (typeof RUNNER_JOB_TERMINAL_STATES)[number];

export const RUNNER_JOB_PHASES = [
  "awaiting-approval",
  "waiting-capacity",
  "staging",
  "executing",
  "collecting",
  "cancelling",
  "reconciling",
  "finished",
] as const;
export const RunnerJobPhaseSchema = z.enum(RUNNER_JOB_PHASES);
export type RunnerJobPhase = z.infer<typeof RunnerJobPhaseSchema>;

export const RunnerJobCleanupStateSchema = z.enum(["pending", "clean", "failed"]);
export type RunnerJobCleanupState = z.infer<typeof RunnerJobCleanupStateSchema>;

/** Failure codes are stable, machine-readable and never leak endpoint or host detail. */
export const RUNNER_JOB_FAILURE_CODES = [
  "approval-denied",
  "queue-expired",
  "timeout",
  "engine-lost",
  "image-missing",
  "image-mismatch",
  "setup-failed",
  "artifact-missing",
  "exit-unknown",
  "worker-lost",
  "bad-path",
  "input-too-large",
  "capacity",
] as const;
export const RunnerJobFailureCodeSchema = z.enum(RUNNER_JOB_FAILURE_CODES);
export type RunnerJobFailureCode = z.infer<typeof RunnerJobFailureCodeSchema>;

export const RunnerJobEventKindSchema = z.enum([
  "queued",
  "dispatched",
  "output",
  "command-started",
  "command-finished",
  "artifact-collected",
  "cancel-requested",
  "cancel-confirmed",
  "cleanup-confirmed",
  "failed",
]);
export const RunnerJobEventStreamSchema = z.enum(["stdout", "stderr", "control"]);
export type RunnerJobEventKind = z.infer<typeof RunnerJobEventKindSchema>;
export type RunnerJobEventStream = z.infer<typeof RunnerJobEventStreamSchema>;

export const RunnerJobEventSchema = z.object({
  jobId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  executionFence: z.number().int().nonnegative(),
  kind: RunnerJobEventKindSchema,
  stream: RunnerJobEventStreamSchema.optional(),
  /** Already redacted, bounded text. */
  payload: z.string().max(8192),
  createdAt: z.iso.datetime(),
});
export type RunnerJobEvent = z.infer<typeof RunnerJobEventSchema>;

export const RunnerJobArtifactSchema = z.object({
  jobId: z.string().min(1),
  artifactId: z.string().min(1).max(64),
  relativePath: RunnerFilePathSchema,
  sha256: z.string().length(64),
  size: z.number().int().nonnegative(),
  collectionState: z.enum(["pending", "collected", "missing", "failed"]),
});
export type RunnerJobArtifact = z.infer<typeof RunnerJobArtifactSchema>;

export const RunnerJobResultSchema = z.object({
  jobId: z.string().min(1),
  runnerId: z.string().min(1),
  state: RunnerJobStateSchema,
  exitCode: z.number().int().nullable(),
  artifacts: z.array(
    RunnerJobArtifactSchema.pick({
      artifactId: true,
      relativePath: true,
      sha256: true,
      size: true,
    }),
  ),
  cleanupState: RunnerJobCleanupStateSchema,
  failureCode: RunnerJobFailureCodeSchema.optional(),
});
export type RunnerJobResult = z.infer<typeof RunnerJobResultSchema>;
