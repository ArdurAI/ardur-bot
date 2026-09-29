export type { EditorTab } from "../workspace/files-model";
export { basename, modified, quickMatches, scanFiles } from "../workspace/files-model";

export function todayRange(now = new Date()) {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  const until = new Date(since);
  until.setDate(until.getDate() + 1);
  return { since: since.toISOString(), until: until.toISOString() };
}

export function ideShortcut(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">,
) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  if (event.code === "Backquote" || event.key === "`") return "terminal";
  const key = event.key.toLowerCase();
  if (key === "a" && event.shiftKey) return "ask";
  if (event.shiftKey) return null;
  return key === "s" ? "save" : key === "p" ? "open" : key === "f" ? "find" : null;
}

const layoutKey = "ardurbot:ide-layout";
export function readLayout() {
  try {
    const value = JSON.parse(window.localStorage.getItem(layoutKey) ?? "null");
    return { tree: clamp(value?.tree, 15, 40, 22), drawer: clamp(value?.drawer, 15, 65, 30) };
  } catch {
    return { tree: 22, drawer: 30 };
  }
}
export function saveLayout(value: { tree: number; drawer: number }) {
  try {
    window.localStorage.setItem(layoutKey, JSON.stringify(value));
  } catch {
    /* Storage is optional. */
  }
}
export const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
