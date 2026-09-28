import type { RunnerLimits, RunnerJobRequest } from "@ardurbot/contracts";

export interface BoundedPolicy {
  maxDurationMs: number;
  maxMemoryMiB: number;
  maxCpus: number;
  maxPids: number;
  tmpfsSizeMiB: number;
  maxInputFiles: number;
  maxInputSizeBytes: number;
  maxInputFileSizeBytes: number;
  maxArtifactFiles: number;
  maxArtifactSizeBytes: number;
  maxArtifactFileSizeBytes: number;
  dropCapabilities: string[];
  noNewPrivileges: boolean;
  nonRootUser: boolean;
  networkMode: "none" | "bridge" | "host";
}

export function evaluateRunnerPolicy(
  limits: RunnerLimits,
  request: RunnerJobRequest,
  usedOwnerMillis: number
): BoundedPolicy {
  // Enforce 15 minute cap
  if (usedOwnerMillis >= limits.maxOwnerDurationMs) {
    throw new Error("Runner owner duration limit exceeded (15 minutes)");
  }
  
  // Cap the duration by what's left
  const maxAllowedDuration = Math.min(
    limits.maxDurationMs,
    limits.maxOwnerDurationMs - usedOwnerMillis
  );

  return {
    maxDurationMs: maxAllowedDuration,
    maxMemoryMiB: limits.maxMemoryMiB,
    maxCpus: limits.maxCpus,
    maxPids: limits.maxPids,
    tmpfsSizeMiB: limits.tmpfsSizeMiB,
    maxInputFiles: limits.maxInputFiles,
    maxInputSizeBytes: limits.maxInputSizeBytes,
    maxInputFileSizeBytes: limits.maxInputFileSizeBytes,
    maxArtifactFiles: limits.maxArtifactFiles,
    maxArtifactSizeBytes: limits.maxArtifactSizeBytes,
    maxArtifactFileSizeBytes: limits.maxArtifactFileSizeBytes,
    dropCapabilities: limits.dropCapabilities,
    noNewPrivileges: limits.noNewPrivileges,
    nonRootUser: limits.nonRootUser,
    networkMode: limits.networkMode,
  };
}
