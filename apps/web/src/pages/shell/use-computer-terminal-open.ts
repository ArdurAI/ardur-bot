export function useComputerTerminalOpen(
  setComputerOpen: (open: boolean) => void,
  setWorkspaceExpanded: (expanded: boolean) => void,
) {
  return () => {
    setComputerOpen(true);
    setWorkspaceExpanded(false);
  };
}
