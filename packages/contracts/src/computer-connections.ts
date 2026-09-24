import { z } from "zod";
import { ComputerProfileSchema } from "./computer-profiles.js";

const quantity = z.string().regex(/^\d+(?:\.\d+)?(?:m|[KMGT]i?)?$/);
export const ComputerConnectionSettingsSchema = z.object({
  engine: z.enum(["docker", "podman", "kubernetes"]),
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
});
export const ComputerConfigurationSchema = z.object({
  botId: z.string().min(1),
  imageProfile: ComputerProfileSchema,
  connectionId: z.string().nullable(),
  confirmed: z.boolean().default(false),
});
export function computerCapabilities(kind: string) {
  return { graphical: kind !== "kubernetes", interactiveTerminal: kind === "docker" };
}

export const ComputerReplacementConfigurationSchema = ComputerConfigurationSchema.omit({
  botId: true,
})
  .partial({ imageProfile: true, connectionId: true })
  .extend({ networkEgress: z.boolean().optional(), confirmed: z.literal(true) });
