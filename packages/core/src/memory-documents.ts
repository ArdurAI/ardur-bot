import type { MemoryDocumentHead } from "@ardurbot/contracts";

export type CategorizedMemoryDocument = MemoryDocumentHead;

export function groupMemoryDocuments(documents: readonly CategorizedMemoryDocument[]) {
  const visible = documents
    .filter(
      (document) =>
        !document.deletedAt &&
        !document.path.startsWith("skills/") &&
        !document.path.startsWith("preferences/"),
    )
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
  return {
    you: visible.filter(
      (document) => document.kind === "profile" || document.kind === "preferences",
    ),
    topics: visible.filter(
      (document) => document.kind !== "profile" && document.kind !== "preferences",
    ),
  };
}

export function memoryDocumentSummary(content: string): string {
  return (
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !/^#{1,6}\s/.test(line)) ?? ""
  )
    .replace(/^[-*+]\s+|^\d+\.\s+/, "")
    .replace(/\s+/g, " ")
    .slice(0, 180);
}

export function memoryTopicTitle(document: Pick<MemoryDocumentHead, "content" | "path">): string {
  const heading = document.content.split(/\r?\n/).find((line) => /^#\s+\S/.test(line));
  return (
    heading?.replace(/^#\s+/, "").trim() ||
    document.path.split("/").at(-1)?.replace(/\.md$/i, "") ||
    document.path
  ).slice(0, 120);
}

export function memoryUpdatedDate(updatedAt: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(updatedAt),
  );
}
