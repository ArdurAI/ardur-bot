import { toComputerRef } from "@ardurbot/adapters";
import type { Actor, WorkspaceContext, WorkspaceGit } from "@ardurbot/contracts";
import { IdePathSchema } from "@ardurbot/contracts";
import { ORPCError } from "@orpc/server";
import type { RouterDeps } from "./router.js";
import type { createWorkspaceFiles } from "./workspace-files.js";

type Deps = Pick<RouterDeps, "sandbox"> & {
  files: ReturnType<typeof createWorkspaceFiles>;
};

export type GitRequest = {
  botId: string;
  computerId: string;
  generation: number;
  path?: string;
  rootId?: string;
};

const unavailable = "Git changes are unavailable on this computer.";

/**
 * Read-only Git observation beside chat. Reuses the workspace root binding checks
 * (bot ownership, root id, generation fence); paths stay workspace-relative and the
 * sandbox provider bounds every Git invocation.
 */
export function createWorkspaceGit(deps: Deps) {
  async function observe(
    actor: Actor,
    input: GitRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceGit> {
    if (input.path !== undefined) {
      IdePathSchema.parse(input.path);
      // The worktree's own metadata is never a diff target.
      const first = input.path.split("/")[0]!.toLowerCase();
      if (first === ".git")
        throw new ORPCError("BAD_REQUEST", { message: "Path escapes registered folders." });
    }
    const resolved = await deps.files.resolve(
      actor,
      {
        botId: input.botId,
        computerId: input.computerId,
        generation: input.generation,
        path: input.path ?? "",
        ...(input.rootId !== undefined ? { rootId: input.rootId } : {}),
      },
      signal,
    );
    const state = resolved.state;
    if (state.files !== "live") throw new ORPCError("CONFLICT", { message: unavailable });
    const observeGit = deps.sandbox.gitChanges;
    if (!observeGit) return { context: state, status: "unavailable" };
    const result = await observeGit.call(
      deps.sandbox,
      toComputerRef(resolved.computer),
      input.path !== undefined ? { path: input.path } : {},
      resolved.adapterContext,
    );
    return mapResult(state, input.path, result);
  }
  return { observe };
}

function mapResult(
  state: WorkspaceContext,
  path: string | undefined,
  result: Awaited<ReturnType<NonNullable<RouterDeps["sandbox"]["gitChanges"]>>>,
): WorkspaceGit {
  switch (result.kind) {
    case "status":
      return {
        context: state,
        status: "ok",
        head: result.head,
        entries: result.entries.map((entry) => ({
          path: entry.path,
          staged: entry.staged,
          unstaged: entry.unstaged,
          untracked: entry.untracked,
          conflict: entry.conflict,
        })),
        ...(result.truncated ? { truncated: true } : {}),
      };
    case "diff":
      if (path === undefined) return { context: state, status: "unavailable" };
      return {
        context: state,
        status: "ok",
        diff: {
          path,
          before: result.before,
          after: result.after,
          binary: result.binary,
          truncated: result.truncated,
        },
      };
    case "not-repository":
      return { context: state, status: "not-repository" };
    default:
      return { context: state, status: "unavailable" };
  }
}
