import type { IdeChange, WorkspaceRootBinding } from "@ardurbot/contracts";
import { rpc } from "../../lib/rpc";

export type ChangeLocation = { changeId: string; since: string; until: string; requestId: number };

/** A bounded page can omit a recorded target; every subsequent page rechecks its root. */
export async function readWorkspaceChange(
  target: WorkspaceRootBinding,
  location: Omit<ChangeLocation, "requestId">,
  signal: AbortSignal,
): Promise<IdeChange> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await rpc.ide.changes(
      { rootId: target.rootId, target, ...location, cursor },
      { signal },
    );
    if (signal.aborted) throw new Error("Cancelled");
    const item = page.items.find(
      (item) => item.id === location.changeId && item.botId === target.botId,
    );
    if (item) return item;
    if (!page.nextCursor || seen.has(page.nextCursor)) break;
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (!signal.aborted);
  throw new Error("Resource not found");
}
