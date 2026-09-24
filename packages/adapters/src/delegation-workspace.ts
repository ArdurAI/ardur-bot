import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";
import type { PrismaClient } from "@ardurbot/db";

/** Workspaces keep task files apart. They do not restrict shell or filesystem authority. */
export async function prepareDelegationWorkspace(
  prisma: PrismaClient,
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  id: string,
  sourceDirectory: string,
) {
  const row = await prisma.delegation.findUniqueOrThrow({ where: { id } });
  if (row.workspacePath) return row.workspacePath;
  if (!/^[a-zA-Z0-9_-]+$/.test(row.rootTaskId) || !/^[a-zA-Z0-9_-]+$/.test(id))
    throw new Error("Invalid task workspace identity.");
  const directory = `tasks/${row.rootTaskId}/${id}`;
  // Every value is a positional argument. No prompt or repository text becomes shell syntax.
  const script = `set -eu
root="$PWD"
source_dir="$1"
target="$root/$2"
mkdir -p "$(dirname "$target")"
if test -d "$target"; then
  if test -f "$target/.git"; then printf worktree; else printf artifacts; fi
elif git -C "$source_dir" rev-parse --verify HEAD >/dev/null 2>&1; then
  git -C "$source_dir" worktree add --detach "$target" HEAD >/dev/null
  printf worktree
else
  mkdir -p "$target"
  printf artifacts
fi`;
  let kind = "";
  let success = false;
  for await (const event of sandbox.execute(
    computer,
    {
      argv: ["bash", "-c", script, "task-workspace", sourceDirectory, directory],
      timeoutMs: 30_000,
    },
    context,
  )) {
    if (event.type === "stdout") kind += event.data;
    if (event.type === "exit") success = event.code === 0;
  }
  if (!success)
    throw new Error("The task workspace could not be prepared; check the computer and retry.");
  await prisma.delegation.update({
    where: { id },
    data: {
      workspacePath: directory,
      workspaceKind: kind.trim() === "worktree" ? "worktree" : "artifacts",
    },
  });
  return directory;
}
export function taskWorkspacePath(directory: string | undefined, requested: string) {
  return directory && !requested.startsWith("/")
    ? `${directory}/${requested.replace(/^\.\//, "")}`
    : requested;
}
