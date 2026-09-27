/** Goal desk work can only report on its own card or return a result. */
import type { TaskCard } from "@ardurbot/contracts";

const PEER_CARD_TOOLS = new Set([
  "report_progress",
  "attach_artifact",
  "complete_task",
  "read_file",
]);

/** Only an exact reference in the admitted card may reach the read path. */
export function peerCardReadInput(card: TaskCard, path: string) {
  return card.inputs.find(
    (input): input is Extract<TaskCard["inputs"][number], { type: "file" | "document" }> =>
      (input.type === "file" && path === `artifact:${input.artifactId}`) ||
      (input.type === "document" && path === `document:${input.documentId}@${input.revision}`),
  );
}

export function peerDocumentWhere(scope: { spaceId: string; userId: string }) {
  return {
    spaceId: scope.spaceId,
    userId: scope.userId,
    deletedAt: null,
    OR: [{ scope: "user" }, { scope: "space-shared" }],
  };
}

export function peerArtifactWhere(scope: {
  spaceId: string;
  userId: string;
  requesterBotId: string;
  groupId: string;
}) {
  return {
    spaceId: scope.spaceId,
    userId: scope.userId,
    OR: [{ botId: scope.requesterBotId, groupId: null }, { groupId: scope.groupId }],
  };
}

export function peerReadOnlyToolAllowed(name: string): boolean {
  return PEER_CARD_TOOLS.has(name) || name === "message_bot";
}

export function peerReadOnlyRuntimeSupported(runtimeKind: string): boolean {
  return runtimeKind === "pi";
}
