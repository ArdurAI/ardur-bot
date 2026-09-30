export function getEffectiveWorkspaceTab(
  tab: string,
  graphical: boolean | undefined,
  filesAvailable: boolean = true,
  terminalAvailable: boolean = false,
): string {
  // Side-effect eligibility only. The pane retains a lost-capability view with
  // its reason; heartbeat and screen requests must still fail closed here.
  return tab === "tasks" ||
    tab === "routines" ||
    (tab === "files" && filesAvailable) ||
    (tab === "terminal" && terminalAvailable) ||
    (tab === "screen" && graphical === true) ||
    (tab === "computer" && graphical !== true)
    ? tab
    : "tasks";
}

export function isComputerVisible(
  computerOpen: boolean,
  panel: string | null,
  effectiveWorkspaceTab: string,
): boolean {
  return (
    computerOpen ||
    (panel === "computer" &&
      (effectiveWorkspaceTab === "screen" || effectiveWorkspaceTab === "computer"))
  );
}
