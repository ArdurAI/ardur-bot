import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { readPrivateFile, writePrivateFile } from "./setup-store.js";

export const MEMORY_COMPOSE_OVERRIDE = "docker-compose.memory.json";
const REGISTRY = "memory-folders.json";
export function memoryFolderBridgeAllowed(input: {
  mainWindow: boolean;
  mainFrame: boolean;
  mode?: string;
  frameUrl: string;
  localUrl: string;
}): boolean {
  if (!input.mainWindow || !input.mainFrame || input.mode !== "new") return false;
  try {
    return new URL(input.frameUrl).origin === new URL(input.localUrl).origin;
  } catch {
    return false;
  }
}
export interface MemoryFolder {
  spaceId: string;
  hostPath: string;
  internalPath: string;
}
export function memoryFolder(spaceId: string, hostPath: string): MemoryFolder {
  if (
    !/^[a-zA-Z0-9_-]{1,160}$/u.test(spaceId) ||
    (!path.isAbsolute(hostPath) && !path.win32.isAbsolute(hostPath)) ||
    Array.from(hostPath).some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Choose a valid memory folder.");
  const hash = createHash("sha256").update(hostPath).digest("hex").slice(0, 24);
  return { spaceId, hostPath, internalPath: `/memory-folders/${spaceId}/${hash}` };
}
export function memoryComposeOverride(folders: MemoryFolder[]): string {
  const volumes = folders.map((folder) => ({
    type: "bind",
    source: folder.hostPath.replaceAll("$", () => "$$"),
    target: folder.internalPath,
    bind: { create_host_path: false },
  }));
  // Neither the bot computer nor its supervisor receives a vault, .git directory, or credentials.
  return JSON.stringify({ services: { api: { volumes }, worker: { volumes } } }, null, 2);
}
export interface MemoryFolderDependencies {
  stackDir: string;
  pick(): Promise<string | null>;
  validate(folder: string): Promise<void>;
  read(file: string): Promise<string | null>;
  write(file: string, value: string): Promise<void>;
  apply(): Promise<void>;
}
export async function validateMemoryFolder(folder: string): Promise<void> {
  if (path.parse(folder).root === folder)
    throw new Error("Choose an empty dedicated memory folder.");
  let current = path.parse(folder).root;
  for (const part of folder.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error("Choose a folder without symbolic links.");
  }
  const entries = await readdir(folder);
  if (entries.length && !entries.includes(".ardur-memory.json"))
    throw new Error("Choose an empty dedicated memory folder.");
}
export function nativeMemoryFolderDependencies(
  stackDir: string,
  pick: MemoryFolderDependencies["pick"],
  apply: MemoryFolderDependencies["apply"],
): MemoryFolderDependencies {
  return {
    stackDir,
    pick,
    apply,
    validate: validateMemoryFolder,
    read: (file) => readPrivateFile(file, 100_000),
    write: writePrivateFile,
  };
}
export async function registerMemoryFolder(
  spaceId: string,
  deps: MemoryFolderDependencies,
): Promise<{ path: string } | null> {
  // Validate identity before opening any native dialog.
  memoryFolder(spaceId, path.resolve(deps.stackDir));
  const selected = await deps.pick();
  if (!selected) return null;
  await deps.validate(selected);
  const registryPath = path.join(deps.stackDir, REGISTRY);
  const overridePath = path.join(deps.stackDir, MEMORY_COMPOSE_OVERRIDE);
  const before = await deps.read(registryPath);
  const folders = before ? (JSON.parse(before) as MemoryFolder[]) : [];
  // Never accept a tampered internal mount target from the persisted registry.
  const valid = folders.map((folder) => memoryFolder(folder.spaceId, folder.hostPath));
  const next = memoryFolder(spaceId, selected);
  const merged = [...valid.filter((folder) => folder.internalPath !== next.internalPath), next];
  await deps.write(overridePath, memoryComposeOverride(merged));
  try {
    await deps.apply();
    await deps.write(registryPath, JSON.stringify(merged));
  } catch {
    await deps.write(overridePath, memoryComposeOverride(valid));
    await deps.apply().catch(() => undefined);
    throw new Error("Could not attach the memory folder. Retry.");
  }
  return { path: next.internalPath };
}
