import type { TerminalSessionCollection } from "@ardurbot/contracts";
import { TERMINAL_SESSION_LIMIT } from "@ardurbot/contracts";

export function addTerminalSession(
  collection: TerminalSessionCollection,
  id: string,
): TerminalSessionCollection {
  if (
    !id ||
    collection.sessions.some((session) => session.id === id) ||
    collection.sessions.length >= TERMINAL_SESSION_LIMIT
  )
    throw new Error("Invalid terminal collection.");
  const number = Math.max(0, ...collection.sessions.map((session) => session.number)) + 1;
  return { sessions: [...collection.sessions, { id, number }], activeId: id };
}
export function removeTerminalSession(
  collection: TerminalSessionCollection,
  id: string,
): TerminalSessionCollection {
  const sessions = collection.sessions.filter((session) => session.id !== id);
  return {
    sessions,
    activeId: sessions.some((session) => session.id === collection.activeId)
      ? collection.activeId
      : (sessions[0]?.id ?? ""),
  };
}
