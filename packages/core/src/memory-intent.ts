import type { MemoryDocumentHead, MemoryDraft } from "@ardurbot/contracts";

export function importedMemoryDrafts(text: string): MemoryDraft[] {
  let kind: MemoryDraft["kind"] = "topic";
  const groups = new Map<MemoryDraft["kind"], string[]>();
  for (const line of text.split(/\r?\n/)) {
    const value = line.trim();
    const heading = value
      .replace(/^#+\s*/, "")
      .replace(/[*:]+/g, "")
      .trim()
      .toLowerCase();
    if (["profile", "preferences", "topics"].includes(heading)) {
      kind = heading === "topics" ? "topic" : (heading as MemoryDraft["kind"]);
      continue;
    }
    if (!value) continue;
    const lines = groups.get(kind) ?? [];
    lines.push(value);
    groups.set(kind, lines);
  }
  return [...groups].map(([kind, lines]) => ({
    action: "save",
    expectedRevision: 0,
    kind,
    content: lines.join("\n"),
  }));
}
export function memoryIntentTarget(
  draft: MemoryDraft,
  documents: MemoryDocumentHead[],
  userId: string,
) {
  if (!draft.documentId) {
    if (draft.action === "delete" || draft.expectedRevision !== 0 || !draft.content.trim())
      throw new Error("Invalid new memory proposal.");
    return null;
  }
  const head = documents.find((item) => item.id === draft.documentId);
  if (
    !head ||
    head.deletedAt ||
    head.scopeKey.kind !== "user" ||
    head.scopeKey.userId !== userId ||
    /^(skills|preferences)\//.test(head.path)
  )
    throw new Error("Memory target is unavailable.");
  if (head.revision !== draft.expectedRevision)
    throw new Error("Memory changed. Try the instruction again.");
  if (draft.action === "save" && !draft.content.trim()) throw new Error("Provide memory content.");
  if (draft.action === "delete" && draft.content !== "")
    throw new Error("A removal must have empty content.");
  return head;
}
