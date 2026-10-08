import type { TerminalSessionCollection } from "@ardurbot/contracts";
import {
  TERMINAL_GRACE_MS,
  TERMINAL_SESSION_LIMIT,
  validateTerminalSize,
} from "@ardurbot/contracts";

export function terminalCollectionKey(scope: {
  userId: string;
  spaceId: string;
  botId: string;
  computerId: string;
  generation: number;
}): string {
  return `ardurbot:terminal-collection:${JSON.stringify([scope.userId, scope.spaceId, scope.botId, scope.computerId, scope.generation])}`;
}

/** Construct only opaque identity and viewport fields from untrusted transient storage. */
export function restoreTerminalCollection(
  value: unknown,
  now: number,
): TerminalSessionCollection | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  if (
    saved.version !== 1 ||
    !Number.isFinite(now) ||
    now < 0 ||
    typeof saved.savedAt !== "number" ||
    !Number.isFinite(saved.savedAt) ||
    now < saved.savedAt ||
    now - saved.savedAt > TERMINAL_GRACE_MS ||
    !Array.isArray(saved.sessions) ||
    !saved.sessions.length ||
    saved.sessions.length > TERMINAL_SESSION_LIMIT
  )
    return null;
  const sessions: { id: string; number: number; cols: number; rows: number }[] = [];
  for (const item of saved.sessions) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 256 ||
      /\s/u.test(item.id) ||
      sessions.some((session) => session.id === item.id) ||
      !Number.isSafeInteger(item.number) ||
      item.number < 1 ||
      item.number > 1_000_000 ||
      sessions.some((session) => session.number === item.number)
    )
      return null;
    try {
      validateTerminalSize(item.cols, item.rows);
    } catch {
      return null;
    }
    sessions.push({ id: item.id, number: item.number, cols: item.cols, rows: item.rows });
  }
  if (
    typeof saved.activeId !== "string" ||
    !sessions.some((session) => session.id === saved.activeId)
  )
    return null;
  return { sessions, activeId: saved.activeId };
}
