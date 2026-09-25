import { oc } from "@orpc/contract";
import { z } from "zod";
import { AvatarStyleSchema } from "./domain.js";

export const WorkTypeSchema = z.enum([
  "",
  "engineering",
  "design",
  "research",
  "operations",
  "education",
  "other",
]);
export const AccountProfileInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  displayName: z.string().trim().max(60),
  workType: WorkTypeSchema,
  avatarStyle: AvatarStyleSchema,
});
export type AccountProfileInput = z.infer<typeof AccountProfileInputSchema>;
export const AccountInstructionsInputSchema = z.strictObject({
  instructions: z.string().max(4000),
  revision: z.number().int().nonnegative(),
});
export const AccountSettingsSchema = AccountProfileInputSchema.extend({
  name: z.string(),
  spaceId: z.string(),
  instructions: z.string().max(4000),
  instructionsRevision: z.number().int().nonnegative(),
  canEditInstructions: z.boolean(),
  canManageDevices: z.boolean(),
  requireTrustedDevices: z.boolean(),
  desktopAvailable: z.boolean(),
});
export type AccountSettings = z.infer<typeof AccountSettingsSchema>;

export const LocalDeviceSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(["host", "device"]),
  name: z.string(),
  platform: z.string().nullable(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().nullable(),
  approved: z.boolean(),
  registrationId: z.string().optional(),
});
export type LocalDevice = z.infer<typeof LocalDeviceSchema>;
export const AccountSessionSchema = z.strictObject({
  id: z.string(),
  device: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  current: z.boolean(),
});
export type AccountSession = z.infer<typeof AccountSessionSchema>;

// Written only by the authenticated settings service and captured by the executor.
// Input limits apply when editing; secret redaction can expand the saved snapshot.
export const AccountInstructionContextSchema = z.strictObject({
  displayName: z.string(),
  workType: WorkTypeSchema,
  instructions: z.string(),
  revision: z.number().int().nonnegative(),
  actorId: z.string().nullable(),
  origin: z.literal("human-settings"),
});
export type AccountInstructionContext = z.infer<typeof AccountInstructionContextSchema>;

const ok = z.object({ ok: z.literal(true) });
export const accountContract = {
  get: oc.output(AccountSettingsSchema),
  updateProfile: oc.input(AccountProfileInputSchema).output(AccountProfileInputSchema),
  updateInstructions: oc
    .input(AccountInstructionsInputSchema)
    .output(z.object({ revision: z.number().int() })),
  setTrustedDevices: oc
    .input(z.strictObject({ required: z.boolean() }))
    .output(z.object({ required: z.boolean() })),
  approveDevice: oc.input(z.strictObject({ id: z.string().min(1) })).output(ok),
  disconnectDevice: oc
    .input(z.strictObject({ id: z.string().min(1), kind: z.enum(["host", "device"]) }))
    .output(ok),
  localDevices: oc.output(z.array(LocalDeviceSchema)),
  sessions: oc.output(z.array(AccountSessionSchema)),
  revokeSession: oc.input(z.strictObject({ id: z.string().min(1) })).output(ok),
  revokeOtherSessions: oc.output(ok),
};
