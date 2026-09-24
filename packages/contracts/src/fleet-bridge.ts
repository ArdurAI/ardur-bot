import { z } from "zod";
import { ComputerConnectionSettingsSchema } from "./computer-connections.js";
import { ComputerProfileSchema } from "./computer-profiles.js";

const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
const path = z
  .string()
  .max(4096)
  .refine((value) => !/[\0\r\n]/.test(value));
const content = z
  .string()
  .max(180000)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const RemoteComputerActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.enum(["kube.capacity", "kube.namespaces", "kube.version"]) }),
  z.strictObject({
    type: z.enum(["kube.read", "kube.remove"]),
    resource: z.enum(["pods", "persistentvolumeclaims"]),
    name: id,
  }),
  z.strictObject({
    type: z.literal("kube.create"),
    resource: z.enum(["pods", "persistentvolumeclaims"]),
    body: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({
    type: z.literal("kube.exec"),
    name: id,
    argv: z.array(z.string().max(65536)).min(1).max(64),
    input: content.optional(),
  }),
  z.strictObject({ type: z.literal("capacity") }),
  z.strictObject({ type: z.literal("test") }),
  z.strictObject({
    type: z.literal("provision"),
    imageProfile: ComputerProfileSchema.default("base"),
  }),
  z.strictObject({ type: z.enum(["prepare", "sleep", "destroy", "snapshot", "export"]) }),
  z.strictObject({ type: z.literal("cwd"), cwd: path.optional() }),
  z.strictObject({
    type: z.literal("exec"),
    argv: z.array(z.string().max(65536)).min(1).max(64),
    cwd: path.optional(),
    env: z.record(z.string(), z.string().max(65536)).optional(),
    pty: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(300000).optional(),
  }),
  z.strictObject({ type: z.literal("files.list"), path }),
  z.strictObject({
    type: z.literal("files.read"),
    path,
    maxBytes: z
      .number()
      .int()
      .nonnegative()
      .max(128 * 1024)
      .optional(),
  }),
  z.strictObject({
    type: z.literal("files.write"),
    path,
    content,
    executable: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("terminal.open"),
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(500),
    shellProfileId: z.string().max(80),
    leaseId: id,
    fence: z.number().int(),
    generation: z.string().max(160),
    expiresAt: z.number().finite(),
    workingRoot: path,
  }),
  z.strictObject({
    type: z.enum(["terminal.output", "terminal.close"]),
    sessionId: z.string().uuid(),
    leaseId: id,
  }),
  z.strictObject({
    type: z.literal("terminal.write"),
    sessionId: z.string().uuid(),
    leaseId: id,
    content,
  }),
  z.strictObject({
    type: z.literal("terminal.resize"),
    sessionId: z.string().uuid(),
    leaseId: id,
    cols: z.number().int().min(1).max(500),
    rows: z.number().int().min(1).max(500),
  }),
  z.strictObject({ type: z.literal("terminal.revoke"), leaseId: id }),
]);
export type RemoteComputerAction = z.infer<typeof RemoteComputerActionSchema>;
export const RemoteComputerCallSchema = z.strictObject({
  op: z.literal("computer.remote.call"),
  homeKey: id,
  connectionId: id,
  settings: ComputerConnectionSettingsSchema,
  action: RemoteComputerActionSchema,
  maintenanceId: id.optional(),
});
export const RemoteDiscoverySchema = z.strictObject({ op: z.literal("computer.remote.discover") });
export const RemoteKubeconfigSchema = z.strictObject({
  op: z.literal("computer.remote.kubeconfig"),
  path: path.optional(),
  context: z.string().min(1).max(256),
});
export const RemoteSecretSchema = z.strictObject({
  op: z.literal("computer.remote.secret"),
  grantId: z.string().uuid(),
  kubeconfig: z.string().max(131072).optional(),
  privateKeyPath: path.optional(),
  tlsPaths: z.strictObject({ ca: path, cert: path, key: path }).optional(),
});
export type RemoteComputerCall = z.infer<typeof RemoteComputerCallSchema>;
