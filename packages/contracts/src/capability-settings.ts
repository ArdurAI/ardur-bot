import { z } from "zod";

export const CapabilityPreferencesSchema = z.object({
  toolAccessMode: z.enum(["when-needed", "all"]).default("when-needed"),
  connectorSearch: z.boolean().default(false),
  inlineVisualizations: z.boolean().default(true),
});
export type CapabilityPreferences = z.infer<typeof CapabilityPreferencesSchema>;
export const ComputerNetworkSettingSchema = z.object({
  id: z.string(),
  name: z.string(),
  networkEgress: z.boolean(),
  supported: z.boolean(),
  pending: z.boolean(),
  kind: z.string(),
});
export const CapabilitySettingsSchema = z.object({
  settings: CapabilityPreferencesSchema,
  canConfigure: z.boolean(),
  computers: z.array(ComputerNetworkSettingSchema),
  unsupportedRuntimes: z.array(z.string()),
});
export const ComputerNetworkInputSchema = z
  .object({
    computerId: z.string().min(1),
    networkEgress: z.boolean(),
    confirmed: z.literal(true),
  })
  .strict();

export type CapabilitySettings = z.infer<typeof CapabilitySettingsSchema>;
export type ComputerNetworkSetting = z.infer<typeof ComputerNetworkSettingSchema>;

export const CapabilityPreferencesPatchSchema = z
  .object({
    toolAccessMode: CapabilityPreferencesSchema.shape.toolAccessMode.removeDefault().optional(),
    connectorSearch: CapabilityPreferencesSchema.shape.connectorSearch.removeDefault().optional(),
    inlineVisualizations: CapabilityPreferencesSchema.shape.inlineVisualizations
      .removeDefault()
      .optional(),
  })
  .strict();
