import { z } from "zod";
import { ComputerProfileSchema } from "./computer-profiles.js";
import { EngineEndpointSchema, SshSettingsSchema } from "./fleet.js";

export const ComputerEngineUnavailableSchema = z.object({
  error: z.literal("engine-unavailable"),
  engine: z.enum(["docker", "podman"]),
  socket: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\r\n\0]+$/),
});
export class ComputerEngineUnavailableError extends Error {
  constructor(failure: z.infer<typeof ComputerEngineUnavailableSchema>) {
    const name = failure.engine === "podman" ? "Podman" : "Docker";
    const application = failure.engine === "podman" ? "Podman" : "Docker Desktop";
    super(
      `${name} is not running or not reachable at ${failure.socket}. Start ${application} and try again.`,
    );
  }
}

const quantity = z.string().regex(/^\d+(?:\.\d+)?(?:m|[KMGT]i?)?$/);
export const ComputerConnectionSettingsSchema = z.object({
  engine: z.enum(["docker", "podman", "kubernetes", "ssh"]),
  endpoint: EngineEndpointSchema.optional(),
  ssh: SshSettingsSchema.optional(),
  dockerContext: z.string().min(1).max(256).optional(),
  hostSecretId: z.string().uuid().optional(),
  socket: z.string().max(1024).optional(),
  context: z.string().max(256).optional(),
  namespace: z
    .string()
    .regex(/^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/)
    .default("ardurbot"),
  storageSize: quantity.default("10Gi"),
  storageClass: z.string().max(256).optional(),
  cpuRequest: quantity.default("250m"),
  cpuLimit: quantity.default("2"),
  memoryRequest: quantity.default("256Mi"),
  memoryLimit: quantity.default("2Gi"),
});
export type ComputerConnectionSettings = z.infer<typeof ComputerConnectionSettingsSchema>;
export const ComputerConnectionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  settings: ComputerConnectionSettingsSchema,
  kubeconfig: z
    .string()
    .min(1)
    .max(1024 * 1024)
    .optional(),
  kubeconfigPath: z.string().min(1).max(1024).optional(),
  privateKeyPath: z.string().min(1).max(4096).optional(),
  tlsPaths: z
    .object({ ca: z.string().max(4096), cert: z.string().max(4096), key: z.string().max(4096) })
    .optional(),
});
/** One host label: darwin and any Mac platform string, otherwise this computer. */
export function hostComputerLabel(
  platform: string | null | undefined,
): "This Mac" | "This computer" {
  if (platform === "darwin" || (platform != null && /mac/i.test(platform))) return "This Mac";
  return "This computer";
}

/** Older clients can still ask for the host. The next step is part of the refusal. */
export function thisMacUnavailableMessage(platform: string | null | undefined) {
  return `${hostComputerLabel(platform)} is not available. Choose a saved connection or keep the current engine.`;
}

/** An empty connection would place a connected computer on the host. That move stays withdrawn. */
export function moveOntoThisMacUnavailableMessage(platform: string | null | undefined) {
  return `Moving this computer onto ${hostComputerLabel(platform)} is not available yet. Choose a saved connection or keep the current engine.`;
}

/** The API may name the host for a different platform than the page that shows the error. */
export function matchesHostRefusal(message: string, kind: "unavailable" | "move") {
  const sentence = kind === "move" ? moveOntoThisMacUnavailableMessage : thisMacUnavailableMessage;
  return (["darwin", "linux"] as const).some((platform) => message === sentence(platform));
}

const ORPC_ERROR_CONSTRUCTORS = Symbol.for("__@orpc/client@1.15.0/error/ORPC_ERROR_CONSTRUCTORS__");

/** A refusal sentence. Registered with the RPC error constructors so the caller sees the sentence. */
export class ConfigurationRefusal extends Error {
  readonly code = "BAD_REQUEST" as const;
  readonly status = 400;
  readonly defined = false;
  readonly data = undefined;
  constructor(message: string) {
    super(message);
    this.name = "ORPCError";
  }
  toJSON() {
    return {
      defined: this.defined,
      code: this.code,
      status: this.status,
      message: this.message,
      data: this.data,
    };
  }
}

export function refuseConfiguration(message: string): never {
  const set = (globalThis as Record<symbol, WeakSet<object> | undefined>)[ORPC_ERROR_CONSTRUCTORS];
  set?.add(ConfigurationRefusal);
  throw new ConfigurationRefusal(message);
}
export const ComputerConfigurationSchema = z.object({
  botId: z.string().min(1),
  imageProfile: ComputerProfileSchema.optional(),
  connectionId: z.string().nullable(),
  /** Refused until verified migration can move a computer onto This Mac. */
  thisMac: z.literal(true).optional(),
  confirmed: z.boolean().default(false),
});
export function computerCapabilities(kind: string) {
  return {
    graphical: !["desktop", "kubernetes", "ssh", "remote-docker"].includes(kind),
    interactiveTerminal: ["docker", "ssh", "remote-docker"].includes(kind),
  };
}

export const ComputerReplacementConfigurationSchema = ComputerConfigurationSchema.omit({
  botId: true,
})
  .partial({ imageProfile: true, connectionId: true })
  .extend({
    networkEgress: z.boolean().optional(),
    targetId: z.string().max(160).optional(),
    confirmed: z.literal(true),
  });
