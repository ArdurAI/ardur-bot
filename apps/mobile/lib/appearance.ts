import type { AppearancePreference, ResolvedAppearance } from "@ardurbot/ui-tokens";
import { tokensForAppearance } from "@ardurbot/ui-tokens";
import type { ColorSchemeName } from "react-native";
import { Appearance } from "react-native";

export type { AppearancePreference, ResolvedAppearance };

const listeners = new Set<() => void>();
/** Native appearance follows the device; desktop account preferences never override it. */
export function getCachedAppearancePreference(): AppearancePreference {
  return "system";
}
export async function loadAppearancePreference(): Promise<AppearancePreference> {
  return "system";
}
export function resolveMobileAppearance(
  _preference: AppearancePreference = "system",
  scheme?: ColorSchemeName | null,
): ResolvedAppearance {
  return (scheme ?? Appearance.getColorScheme()) === "light" ? "light" : "dark";
}
export function mobileTokens(
  _preference: AppearancePreference = "system",
  scheme?: ColorSchemeName | null,
) {
  return tokensForAppearance(resolveMobileAppearance("system", scheme));
}
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
Appearance.addChangeListener(() => {
  for (const listener of listeners) listener();
});
