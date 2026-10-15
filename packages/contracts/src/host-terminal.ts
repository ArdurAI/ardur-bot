import * as z from "zod";

const grant = {
  leaseId: z.string().min(1).max(160),
  fence: z.number().int().nonnegative(),
  generation: z.string().min(1).max(160),
  hostGeneration: z.uuid(),
  expiresAt: z.number().int().positive(),
};
const session = { ...grant, sessionId: z.uuid() };
/** Every frame carries the control grant; no caller environment or executable is accepted. */
export const HostTerminalActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("cwd"), ...grant, cwd: z.string().max(4096).optional() }),
  z.strictObject({
    type: z.literal("open"),
    ...grant,
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(1).max(300),
    shellProfileId: z.literal("default"),
    workingRoot: z.string().min(1).max(4096),
  }),
  z.strictObject({
    type: z.literal("write"),
    ...session,
    content: z
      .string()
      .max(87384)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  z.strictObject({
    type: z.literal("resize"),
    ...session,
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(1).max(300),
  }),
  z.strictObject({ type: z.enum(["close", "output"]), ...session }),
  z.strictObject({ type: z.literal("revoke"), ...grant }),
]);
export type HostTerminalAction = z.infer<typeof HostTerminalActionSchema>;
