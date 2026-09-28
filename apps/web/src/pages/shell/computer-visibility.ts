export function isComputerVisible(
  computerOpen: boolean,
  panel: string | null,
  workspaceTab: string,
): boolean {
  return computerOpen || (panel === "computer" && (workspaceTab === "screen" || workspaceTab === "computer"));
}
