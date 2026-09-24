import type { CapabilityPreferences, SpaceLearningConfig } from "@ardurbot/contracts";
import {
  CapabilityPreferencesPatchSchema,
  CapabilityPreferencesSchema,
  CapabilitySettingsSchema,
  ComputerNetworkInputSchema,
  LearningProposalSchema,
  MemoryIntentInputSchema,
  SpaceLearningConfigSchema,
} from "@ardurbot/contracts";
import { rpc } from "./api";

export async function loadCapabilitySettings() {
  return CapabilitySettingsSchema.parse(await rpc("capabilities/settings", {}));
}
export async function saveCapabilitySettings(patch: Partial<CapabilityPreferences>) {
  return CapabilityPreferencesSchema.parse(
    await rpc("capabilities/configure", CapabilityPreferencesPatchSchema.parse(patch)),
  );
}
export async function setComputerNetwork(input: {
  computerId: string;
  networkEgress: boolean;
  confirmed: boolean;
}) {
  return rpc("capabilities/network", ComputerNetworkInputSchema.parse(input));
}
export async function setMemoryGeneration(settings: SpaceLearningConfig, enabled: boolean) {
  if (!settings.canConfigure) throw new Error("Only the space owner can change this setting.");
  return SpaceLearningConfigSchema.parse(
    await rpc("learning/configure", {
      enabled,
      consolidationEnabled: settings.consolidationEnabled,
      reviewerPin: settings.reviewerPin ?? settings.destination,
      budgets: settings.budgets,
    }),
  );
}
export async function proposeMemoryChange(input: {
  intent: "import" | "edit";
  text: string;
  requestId: string;
}) {
  return LearningProposalSchema.array().parse(
    await rpc("memory/propose", MemoryIntentInputSchema.parse(input)),
  );
}
