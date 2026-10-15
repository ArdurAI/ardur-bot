import type { TerminalSessionCollection } from "@ardurbot/contracts";
import { restoreTerminalCollection } from "@ardurbot/core";

export function readTerminalCollection(key: string | undefined): TerminalSessionCollection | null {
  if (!key) return null;
  try {
    const text = window.sessionStorage.getItem(key);
    return text && text.length <= 4096
      ? restoreTerminalCollection(JSON.parse(text), Date.now())
      : null;
  } catch {
    return null;
  }
}
export function writeTerminalCollection(
  key: string | undefined,
  collection: TerminalSessionCollection,
  ids: Record<string, string>,
): void {
  if (!key) return;
  const sessions = collection.sessions.flatMap((session) =>
    ids[session.id]
      ? [
          {
            id: ids[session.id],
            number: session.number,
            cols: session.cols ?? 80,
            rows: session.rows ?? 24,
          },
        ]
      : [],
  );
  const activeId = ids[collection.activeId] ?? sessions[0]?.id;
  try {
    if (!sessions.length) window.sessionStorage.removeItem(key);
    else
      window.sessionStorage.setItem(
        key,
        JSON.stringify({ version: 1, savedAt: Date.now(), sessions, activeId }),
      );
  } catch {
    /* Session storage is optional; rejoining still needs server authorization. */
  }
}
export function clearTerminalCollection(key: string | undefined): void {
  try {
    if (key) window.sessionStorage.removeItem(key);
  } catch {
    /* Storage is optional. */
  }
}
