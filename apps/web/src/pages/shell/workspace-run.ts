import type { RunActivityRow } from "@ardurbot/contracts";

export function isWorkspaceDesktopLayout(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 768px)").matches;
}

export function handleWorkspaceOpenRun({
  run,
  navigate,
  closePanel,
  isDesktop = isWorkspaceDesktopLayout(),
}: {
  run: RunActivityRow;
  navigate: (path: string) => void;
  closePanel: () => void;
  isDesktop?: boolean;
}) {
  if (!isDesktop) closePanel();
  navigate(run.groupId ? `/app/g/${run.groupId}` : `/app/${run.botId}`);
}
