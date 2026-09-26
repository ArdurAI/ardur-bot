import { realpath, stat } from "node:fs/promises";
import type { CommandRequest } from "@ardurbot/adapter-kit";
import { isAllowedDesktopPath } from "./desktop-sandbox-paths.js";
import { getHostEnvironment, resolveHostBinary } from "./host-environment.js";

export async function confinedHostCwd(candidate: string, roots: string[]) {
  if (candidate.includes("\0") || candidate.split(/[/\\]/u).includes(".."))
    throw new Error("Path escapes registered folders.");
  const resolved = await realpath(candidate);
  const registered = await resolvedRoots(roots);
  if (!isAllowedDesktopPath(resolved, registered) || !(await stat(resolved)).isDirectory())
    throw new Error("Path escapes registered folders.");
  return resolved;
}

/**
 * Folders that resolve now. A registered folder that is gone (an unplugged drive, a renamed
 * project) is skipped for this command instead of failing every command.
 */
export async function resolvedRoots(roots: string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => null)));
  return resolved.filter((root) => root !== null);
}

/** The executor owns approvals. The host owns executable and environment selection. */
export async function hostCommand(request: CommandRequest, env?: NodeJS.ProcessEnv) {
  if (request.env !== undefined || request.pty || !request.argv.length)
    throw new Error(
      "Command did not run: host environment and terminal overrides are not allowed.",
    );
  const [name, ...args] = request.argv;
  if (!name || /[/\\:\0\r\n]/u.test(name) || args.some((arg) => arg.includes("\0")))
    throw new Error(
      "Command did not run: use a tool name from this computer's PATH, not an executable path.",
    );
  const binary = await resolveHostBinary(name, env ?? (await getHostEnvironment()).env);
  if (!binary)
    throw new Error("Command did not run: executable was not found on this computer's PATH.");
  return [binary, ...args];
}
