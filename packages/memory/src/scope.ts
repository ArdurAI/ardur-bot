import type { DocumentScope, MemoryAccess } from "@ardurbot/adapter-kit";
import { MemoryAccessError } from "@ardurbot/adapter-kit";
import { DocumentScopeSchema } from "@ardurbot/contracts";

export function scopeKey(scope: DocumentScope): string {
  const parsed = DocumentScopeSchema.parse(scope);
  return JSON.stringify(
    parsed.kind === "space-shared"
      ? [parsed.spaceId, parsed.kind]
      : parsed.kind === "user"
        ? [parsed.spaceId, parsed.kind, parsed.userId]
        : [parsed.spaceId, parsed.kind, parsed.userId, parsed.botId],
  );
}
export function canAccess(scope: DocumentScope, access: MemoryAccess): boolean {
  return (
    scope.spaceId === access.spaceId &&
    (scope.kind === "space-shared" ||
      (scope.userId === access.userId &&
        (scope.kind === "user" ||
          (access.botIds.includes(scope.botId) &&
            (!access.botId || access.botId === scope.botId)))))
  );
}
export function assertScope(scope: DocumentScope, access: MemoryAccess): void {
  DocumentScopeSchema.parse(scope);
  if (!canAccess(scope, access)) throw new MemoryAccessError();
}
export function ownedScope(
  kind: DocumentScope["kind"],
  access: MemoryAccess,
  botId = access.botId,
): DocumentScope {
  const scope: DocumentScope =
    kind === "space-shared"
      ? { kind, spaceId: access.spaceId }
      : kind === "user"
        ? { kind, spaceId: access.spaceId, userId: access.userId }
        : { kind, spaceId: access.spaceId, userId: access.userId, botId: botId ?? "" };
  assertScope(scope, access);
  return scope;
}
