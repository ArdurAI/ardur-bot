import type { IdeEntry, IdeFile } from "@ardurbot/contracts";

export type EditorTab = IdeFile & { id: string; savedContent: string };
export const modified = (tab: EditorTab) => tab.content !== tab.savedContent;
export const basename = (path: string) => path.split(/[/\\]/).at(-1) || path;

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
