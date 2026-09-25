import type { ArdurBotDesktop } from "@ardurbot/contracts";
import { DESKTOP_FOLDER_ERRORS } from "@ardurbot/contracts/desktop-errors";
import type { ComposerMention } from "@ardurbot/core";
import { knownActionError } from "../../lib/known-action-error";

export function composerFolderError(error: unknown, fallback = "Could not add folder. Try again.") {
  if (
    error instanceof Error &&
    /No handler registered for ['"]desktop\.host\.addRoot['"]/.test(error.message)
  )
    return "Restart the desktop app to update it.";
  return knownActionError(error, DESKTOP_FOLDER_ERRORS, fallback);
}

export async function pickComposerFolder(
  host: ArdurBotDesktop["host"],
  dropped?: File,
): Promise<ComposerMention | null> {
  if (!host) throw new Error("Folders require this computer.");
  if (typeof host.addRoot !== "function" || (dropped && typeof host.addDroppedRoot !== "function"))
    throw new Error("Restart the desktop app to update it.");
  const path = dropped ? await host.addDroppedRoot!(dropped) : await host.addRoot();
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
