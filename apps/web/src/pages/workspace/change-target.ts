import type { IdeChange, WorkspaceRootBinding } from "@ardurbot/contracts";
import { rpc } from "../../lib/rpc";

export type ChangeLocation = { changeId: string; since: string; until: string; requestId: number };

/** Look up one recorded target within the server-checked root and time window. */
export async function readWorkspaceChange(
  target: WorkspaceRootBinding,
  location: Omit<ChangeLocation, "requestId">,
  signal: AbortSignal,
): Promise<IdeChange> {
  if (signal.aborted) throw new Error("Cancelled");
  const page = await rpc.ide.changes({ rootId: target.rootId, target, ...location }, { signal });
  if (signal.aborted) throw new Error("Cancelled");
  const item = page.items.find(
    (item) => item.id === location.changeId && item.botId === target.botId,
  );
  if (item) return item;
  throw new Error("Resource not found");
}
