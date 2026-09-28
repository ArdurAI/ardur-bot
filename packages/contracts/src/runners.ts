import { z } from "zod";

// Capabilities schema as requested in the design
export const RunnerCapabilitiesSchema = z.object({
  docker: z.boolean().default(false),
  bash: z.boolean().default(true),
  node: z.boolean().default(true),
  python: z.boolean().default(true),
  memoryMiB: z.number().int().positive().optional(),
  cpus: z.number().positive().optional(),
});
export type RunnerCapabilities = z.infer<typeof RunnerCapabilitiesSchema>;

export const RunnerLimitsSchema = z.object({
  maxDurationMs: z.number().int().positive().default(300000), // 5 min
  maxOwnerDurationMs: z.number().int().positive().default(900000), // 15 min
  maxMemoryMiB: z.number().int().positive().default(2048), // 2 GiB
  maxCpus: z.number().positive().default(2),
  maxPids: z.number().int().positive().default(256),
  tmpfsSizeMiB: z.number().int().positive().default(512), // 512 MiB
  maxInputFiles: z.number().int().positive().default(10000),
  maxInputSizeBytes: z.number().int().positive().default(67108864), // 64 MiB
  maxInputFileSizeBytes: z.number().int().positive().default(16777216), // 16 MiB
  maxArtifactFiles: z.number().int().positive().default(50),
  maxArtifactSizeBytes: z.number().int().positive().default(67108864), // 64 MiB
  maxArtifactFileSizeBytes: z.number().int().positive().default(16777216), // 16 MiB
  dropCapabilities: z.array(z.string()).default(["ALL"]),
  noNewPrivileges: z.boolean().default(true),
  nonRootUser: z.boolean().default(true),
  networkMode: z.enum(["none", "bridge", "host"]).default("none"),
});
export type RunnerLimits = z.infer<typeof RunnerLimitsSchema>;

export const RunnerEnvironmentToolsSchema = z.object({
  packages: z.array(z.string()).default([]),
});
export type RunnerEnvironmentTools = z.infer<typeof RunnerEnvironmentToolsSchema>;

export const RunnerJobRequestSchema = z.object({
  runnerId: z.string(),
  command: z.array(z.string()),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  inputs: z.array(z.object({
    path: z.string(),
    content: z.string(),
  })).optional(),
});
export type RunnerJobRequest = z.infer<typeof RunnerJobRequestSchema>;

