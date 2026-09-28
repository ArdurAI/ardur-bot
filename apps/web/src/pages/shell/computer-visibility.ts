export function getEffectiveWorkspaceTab(
  tab: string,
  graphical: boolean | undefined,
  filesAvailable: boolean = true,
): string {
  return tab === "tasks" ||
    tab === "routines" ||
    (tab === "files" && filesAvailable) ||
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
