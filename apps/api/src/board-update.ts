import type { BoardScope, BoardService } from "@ardurbot/adapters";
import type { BoardPatch } from "@ardurbot/contracts/board";

/** Close-when-done shares the filing lock with goal delivery, so consent cannot change mid-close. */
export function updateOwnerBoardItem(
  service: Pick<BoardService, "provider" | "withFilingLock">,
  actor: BoardScope,
  input: { workspaceId: string; id: string; patch: BoardPatch },
) {
  const apply = () =>
    service
      .provider(actor, input.workspaceId)
      .then((provider) => provider.update(input.id, input.patch));
  if (input.patch.closeWhenDone === undefined) return apply();
  return service.withFilingLock(actor, apply);
}
