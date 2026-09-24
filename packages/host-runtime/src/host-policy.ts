import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CommandRequest } from "@ardurbot/adapter-kit";
import { isAllowedDesktopPath } from "./desktop-sandbox-paths.js";
import { nativeEnvironment } from "./runtimes/native-process.js";

export async function confinedHostCwd(candidate: string, roots: string[]) {
  if (candidate.includes("\0") || candidate.split(/[/\\]/u).includes(".."))
    throw new Error("Path escapes registered folders.");
  const resolved = await realpath(candidate);
  const registered = await Promise.all(roots.map((root) => realpath(root)));
  if (!isAllowedDesktopPath(resolved, registered) || !(await stat(resolved)).isDirectory())
    throw new Error("Path escapes registered folders.");
  return resolved;
}

/** Small effect-free command grammar. File access uses the confined file operations. */
export async function hostCommand(request: CommandRequest, env = nativeEnvironment()) {
  if (request.env !== undefined || request.pty || !request.argv.length)
    throw new Error(
      "This computer runs only echo, pwd and whoami as bot commands; use the file tools, or a Claude Code or Codex runtime, for other work.",
    );
  const [name, ...args] = request.argv;
  if (
    !name ||
    !["echo", "pwd", "whoami"].includes(name) ||
    args.some((arg) => /[\0\r\n;&|`$<>]/u.test(arg)) ||
    (name !== "echo" && args.length)
  )
    throw new Error(
      "This computer runs only echo, pwd and whoami as bot commands; use the file tools, or a Claude Code or Codex runtime, for other work.",
    );
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, process.platform === "win32" ? `${name}.exe` : name);
    try {
      await access(candidate, constants.X_OK);
      const binary = await realpath(candidate);
      return [binary, ...args];
    } catch {
      /* Try the next registered OS search directory. */
    }
  }
  throw new Error("Approved host command is unavailable.");
}
