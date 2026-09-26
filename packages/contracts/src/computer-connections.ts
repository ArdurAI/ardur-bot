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
export const HOST_MOVE_UNAVAILABLE_MESSAGE =
  "Moving a computer onto the machine running Ardur Bot is not available yet. Choose a saved connection or keep the current engine.";
/** A computer can never be moved onto the host: one typed error, detected by class, not text. */
export class HostMoveUnavailableError extends Error {
  constructor() {
    super(HOST_MOVE_UNAVAILABLE_MESSAGE);
    this.name = "HostMoveUnavailableError";
  }
}
const ComputerConfigurationFieldsSchema = z.object({
  botId: z.string().min(1),
  imageProfile: ComputerProfileSchema.optional(),
  /** Omitted keeps the computer where it is; null chooses the deployment default. */
  connectionId: z.string().nullable().optional(),
  confirmed: z.boolean().default(false),
});
/** A configuration that changes neither the profile nor the connection is not a request. */
export const ComputerConfigurationSchema = ComputerConfigurationFieldsSchema.refine(
  (configuration) =>
    configuration.imageProfile !== undefined || configuration.connectionId !== undefined,
  { message: "Choose an image profile or a connection to change." },
);
export function computerCapabilities(kind: string) {
  return {
    graphical: !["desktop", "kubernetes", "ssh", "remote-docker"].includes(kind),
    interactiveTerminal: ["docker", "ssh", "remote-docker"].includes(kind),
  };
}

export const ComputerReplacementConfigurationSchema = ComputerConfigurationFieldsSchema.omit({
  botId: true,
}).extend({ networkEgress: z.boolean().optional(), confirmed: z.literal(true) });
