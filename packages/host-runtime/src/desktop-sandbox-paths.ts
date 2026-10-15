import path from "node:path";
import { normalizeWorkspacePath } from "./computer-support.js";

type PathOperations = Pick<typeof path, "isAbsolute" | "relative" | "resolve" | "sep">;

const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

export function normalizeDesktopWorkspacePath(value: string, platform = process.platform) {
  if (platform === "win32") assertPortableWindowsPath(value);
  return normalizeWorkspacePath(value);
}

export function isAllowedDesktopPath(
  target: string,
  roots: string[],
  pathOperations: PathOperations = path,
) {
  const windows = pathOperations.sep === "\\";
  const normalizedTarget = windows ? windowsContainmentPath(target) : target;
  if (normalizedTarget === undefined) return false;
  const resolved = pathOperations.resolve(normalizedTarget);
  return roots.some((root) => {
    const normalizedRoot = windows ? windowsContainmentPath(root) : root;
    if (normalizedRoot === undefined) return false;
    const relative = pathOperations.relative(pathOperations.resolve(normalizedRoot), resolved);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${pathOperations.sep}`) &&
        !pathOperations.isAbsolute(relative))
    );
  });
}

function windowsContainmentPath(value: string): string | undefined {
  let normalized = value.replace(/\//g, "\\");
  // Only DOS and UNC final names are supported. Never turn a device namespace
  // into an ordinary path by blindly stripping its prefix.
  if (/^\\\\\?\\UNC\\/iu.test(normalized)) normalized = `\\\\${normalized.slice(8)}`;
  else if (/^\\\\\?\\[a-z]:\\/iu.test(normalized)) normalized = normalized.slice(4);
  if (!/^(?:[a-z]:\\|\\\\[^\\?.][^\\]*\\[^\\]+(?:\\|$))/iu.test(normalized)) return undefined;
  const segments = normalized
    .replace(/^[a-z]:/iu, "")
    .split("\\")
    .filter(Boolean);
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        hasWindowsReservedCharacter(segment) ||
        /[ .]$/u.test(segment) ||
        WINDOWS_RESERVED_NAME.test(segment.split(".", 1)[0] ?? ""),
    )
  )
    return undefined;
  return normalized;
}

function assertPortableWindowsPath(value: string) {
  const portable = value.replace(/\\/g, "/");
  if (portable.startsWith("//")) throw new Error("Path escapes the computer workspace");
  const withoutVirtualRoot = portable.replace(/^\/+/, "");
  for (const segment of withoutVirtualRoot.split("/").filter(Boolean)) {
    const deviceName = segment.split(".", 1)[0] ?? "";
    if (
      hasWindowsReservedCharacter(segment) ||
      /[ .]$/u.test(segment) ||
      WINDOWS_RESERVED_NAME.test(deviceName)
    ) {
      throw new Error("Path escapes the computer workspace");
    }
  }
}

function hasWindowsReservedCharacter(segment: string) {
  return [...segment].some(
    (character) => character.charCodeAt(0) <= 31 || '<>:"|?*'.includes(character),
  );
}
