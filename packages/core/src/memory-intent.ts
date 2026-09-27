import type { MemoryDocumentHead, MemoryDraft } from "@ardurbot/contracts";

export function importedMemoryDrafts(text: string): MemoryDraft[] {
  const drafts: MemoryDraft[] = [];
  let kind: MemoryDraft["kind"] = "topic";
  let start = 0;
  const add = (end: number) => {
    const content = text.slice(start, end);
    if (content.trim()) drafts.push({ action: "save", expectedRevision: 0, kind, content });
  };
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    const line = match[0].replace(/\r?\n$|\r$/, "");
    const heading = line
      .trim()
      .replace(/^#+\s*/, "")
      .replace(/[*:]+$/g, "")
      .trim()
      .toLowerCase();
    if (heading !== "profile" && heading !== "preferences" && heading !== "topics") continue;
    const offset = match.index;
    add(offset);
    kind = heading === "topics" ? "topic" : heading;
    start = offset + match[0].length;
  }
  add(text.length);
  if (drafts.length > 3) throw new Error("Split this import into at most three sections.");
  return drafts;
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
