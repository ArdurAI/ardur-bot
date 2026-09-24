import { z } from "zod";
import { ComputerProfileSchema } from "./computer-profiles.js";
import { EngineEndpointSchema, SshSettingsSchema } from "./fleet.js";

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
export const ComputerConfigurationSchema = z.object({
  botId: z.string().min(1),
  imageProfile: ComputerProfileSchema,
  connectionId: z.string().nullable(),
  confirmed: z.boolean().default(false),
});
export function computerCapabilities(kind: string) {
  return {
    graphical: !["kubernetes", "ssh", "remote-docker"].includes(kind),
    interactiveTerminal: ["docker", "ssh", "remote-docker"].includes(kind),
  };
}
