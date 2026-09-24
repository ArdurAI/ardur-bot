import type { ComputerStatus } from "@ardurbot/contracts";

/** Only the Docker adapter exposes page-browser control; host health is not browser control. */
export function connectedBrowsers(
  computers: { name: string; botId: string; status: ComputerStatus }[],
) {
  const seen = new Set<string>();
  return computers.flatMap((computer) => {
    const status = computer.status;
    if (
      status.kind !== "docker" ||
      status.state !== "running" ||
      !status.screenAvailable ||
      status.capabilities?.graphical === false
    )
      return [];
    const id = status.computerId ?? computer.botId;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, name: computer.name }];
  });
}
