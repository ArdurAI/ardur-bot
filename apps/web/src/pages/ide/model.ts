import type { IdeEntry, IdeFile } from "@ardurbot/contracts";

export type EditorTab = IdeFile & { id: string; savedContent: string };
export const modified = (tab: EditorTab) => tab.content !== tab.savedContent;
export const basename = (path: string) => path.split(/[/\\]/).at(-1) || path;
export function todayRange(now = new Date()) {
  const since = new Date(now);
  since.setHours(0, 0, 0, 0);
  const until = new Date(since);
  until.setDate(until.getDate() + 1);
  return { since: since.toISOString(), until: until.toISOString() };
}

/** Only quick-open opts into walking directories; ordinary tree expansion stays one level. */
export async function scanFiles(
  list: (path: string) => Promise<IdeEntry[]>,
  signal: AbortSignal,
  receive: (files: IdeEntry[]) => void,
) {
  const directories = [""];
  const seen = new Set<string>();
  for (let index = 0; index < directories.length; index++) {
    signal.throwIfAborted();
    const directory = directories[index]!;
    if (seen.has(directory)) continue;
    seen.add(directory);
    const entries = await list(directory);
    signal.throwIfAborted();
    receive(entries.filter((entry) => entry.kind === "file"));
    for (const entry of entries) if (entry.kind === "dir") directories.push(entry.path);
  }
}
export function quickMatches(files: IdeEntry[], query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return files
    .filter((file) => basename(file.path).toLocaleLowerCase().includes(needle))
    .slice(0, 100);
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
