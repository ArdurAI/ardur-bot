import type { ArdurBotDesktop } from "@ardurbot/contracts";
import type { ComposerMention } from "@ardurbot/core";

export async function pickComposerFolder(
  host: NonNullable<ArdurBotDesktop["host"]>,
  dropped?: File,
): Promise<ComposerMention | null> {
  const path = dropped ? await host.addDroppedRoot?.(dropped) : await host.addRoot();
  if (!path) return null;
  return { kind: "folder", id: path, name: path.split(/[\\/]/).filter(Boolean).pop() ?? path };
}

/** Never recurse through directories or treat them as zero-byte uploads. */
export function splitComposerDrop(data: DataTransfer): { files: File[]; folders: File[] } {
  const files: File[] = [];
  const folders: File[] = [];
  const items = Array.from(data.items ?? []).filter((item) => item.kind === "file");
  if (!items.length) return { files: Array.from(data.files), folders };
  for (const item of items) {
    const file = item.getAsFile();
    if (!file) continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) folders.push(file);
    else files.push(file);
  }
  return { files, folders };
}
