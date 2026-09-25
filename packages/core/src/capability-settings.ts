import type { CapabilityPreferences } from "@ardurbot/contracts";

/** All current runtimes deliver catalog search/load/execute through the same authorized bridge. */
export function effectiveToolAccessMode(
  mode: CapabilityPreferences["toolAccessMode"],
  runtime: string,
) {
  return ["pi", "claude-code", "codex-app-server"].includes(runtime) ? mode : "all";
}
export function capabilityAllowsTool(settings: CapabilityPreferences, name: string) {
  if (name === "search_connectors") return settings.connectorSearch;
  if (name === "render_plot") return settings.inlineVisualizations;
  return true;
}
