/** The most folders a computer grants to bots. */
export const MAX_REGISTERED_FOLDERS = 32;

/**
 * A folders file is a JSON array of absolute paths. Anything unreadable grants nothing.
 * `isAbsolute` is the reading platform's own check, so a Windows path is never read as
 * relative on POSIX.
 */
export function parseRegisteredFolders(text, isAbsolute) {
  if (typeof text !== "string") return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry) => typeof entry === "string" && !entry.includes("\0") && isAbsolute(entry))
    .slice(0, MAX_REGISTERED_FOLDERS);
}
