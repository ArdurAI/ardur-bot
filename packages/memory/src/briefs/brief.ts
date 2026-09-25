import type { MemoryDocumentHead } from "@ardurbot/adapter-kit";
import { MemoryConflictError } from "@ardurbot/adapter-kit";
import type { MemoryOperationContext, MemoryService } from "../service.js";

export const BRIEF_LIMIT = 6000;
export const BRIEF_SECTIONS = [
  "Goal",
  "People and bots",
  "Open items",
  "Last decisions",
  "Pointers",
] as const;
const SECTION_LIMITS = [700, 800, 1700, 1300, 1300];
export function briefPath(groupId: string | null): string {
  return `briefs/${groupId ?? "direct"}.md`;
}
export function normalizeBrief(content: string): string {
  const sections = new Map<string, string[]>();
  let heading = "Open items";
  for (const line of content.split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match && BRIEF_SECTIONS.some((section) => section === match[1])) heading = match[1]!;
    else {
      if (!sections.has(heading)) sections.set(heading, []);
      sections.get(heading)!.push(line);
    }
  }
  return BRIEF_SECTIONS.map(
    (section, index) =>
      `## ${section}\n${(sections.get(section) ?? []).join("\n").trim().slice(0, SECTION_LIMITS[index])}`,
  ).join("\n\n");
}
/** Keep the existing bytes, including human edits; only use remaining room in Open items. */
export function appendBrief(current: string, addition: string): string {
  const header = /^## Open items\s*$/m.exec(current);
  const start = header ? header.index + header[0].length : current.length;
  const next = current.slice(start).search(/\n## /);
  const end = next < 0 ? current.length : start + next;
  const prefix = header ? "\n" : "\n\n## Open items\n";
  const remainingSection = SECTION_LIMITS[2]! - current.slice(start, end).trim().length;
  const room = Math.min(BRIEF_LIMIT - current.length, remainingSection);
  if (room <= prefix.length || !addition.trim()) return current;
  const text = (prefix + addition.trim()).slice(0, room);
  return current.slice(0, end) + text + current.slice(end);
}
export async function readBrief(
  service: MemoryService,
  botId: string,
  groupId: string | null,
  context: MemoryOperationContext,
) {
  const page = await service.list(
    { scope: "group", botId, groupId: groupId ?? "direct", limit: 100 },
    context,
  );
  return page.items.find((doc) => doc.path === briefPath(groupId)) ?? null;
}
export async function rewriteBrief(input: {
  service: MemoryService;
  botId: string;
  groupId: string | null;
  context: MemoryOperationContext;
  summarize: (current: string) => Promise<string | null>;
  now?: Date;
}): Promise<{ document: MemoryDocumentHead | null; reason: string | null }> {
  const { service, botId, groupId, context } = input;
  const current = await readBrief(service, botId, groupId, context);
  let protectedByHuman = false;
  if (current) {
    const cutoff = (input.now ?? new Date()).getTime() - 3_600_000;
    let cursor: number | undefined;
    do {
      const history = await service.history(current.id, { limit: 100, cursor }, context);
      protectedByHuman = history.items.some(
        (revision) => revision.author.kind === "user" && Date.parse(revision.createdAt) > cutoff,
      );
      cursor =
        !protectedByHuman &&
        history.items.length > 0 &&
        Date.parse(history.items.at(-1)!.createdAt) > cutoff
          ? (history.nextCursor ?? undefined)
          : undefined;
    } while (cursor);
  }
  const summary = await input.summarize(current?.content ?? normalizeBrief(""));
  if (!summary?.trim()) return { document: current, reason: "Model unavailable" };
  const normalized = normalizeBrief(summary);
  const openItems = normalized.split("## Open items\n")[1]?.split("\n\n## ")[0] ?? "";
  const content =
    protectedByHuman && current ? appendBrief(current.content, openItems) : normalized;
  const write = (base: MemoryDocumentHead | null, value: string) =>
    service.commit(
      {
        id: base?.id,
        scope: "group",
        botId,
        groupId: groupId ?? "direct",
        path: briefPath(groupId),
        content: value,
        expectedRevision: base?.revision ?? 0,
      },
      context,
    );
  try {
    if (content === current?.content)
      return { document: current, reason: protectedByHuman ? "Owner edited recently" : null };
    return { document: await write(current, content), reason: null };
  } catch (error) {
    if (!(error instanceof MemoryConflictError)) throw error;
    const latest = await readBrief(service, botId, groupId, context);
    if (!latest || latest.deletedAt) throw error;
    return { document: await write(latest, appendBrief(latest.content, openItems)), reason: null };
  }
}
